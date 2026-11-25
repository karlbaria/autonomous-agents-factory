"""JS/TS review probes (#69): run with the package's own runner, or reported not runnable.

The fixture is shaped like factory-shop: a React frontend in ``frontend/``
(``package.json`` with Vitest, ``vite.config.js``, ``src/App.jsx``) and an
``infra/`` package with no test runner. ``frontend/node_modules/.bin/vitest``
is a small shell stand-in for Vitest, since the unit tests cannot ``npm
install``. It behaves like ``vitest run <file>`` where it matters here:

- It must be run from the package root (where ``vite.config.js`` is).
- It only finds files named ``*.test.*``.
- It fails on a relative import that does not resolve from the probe's
  directory.
- It passes when the text the probe expects (``// expects: <text>``) is in the
  package's ``src/``, and fails otherwise.
"""

from __future__ import annotations

import re
import stat
import subprocess
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from models import AgentInvocationLedger, AgentResult, RepoSetup, TaskConfig
from post_hooks import _render_round_probes_and_findings
from review.backend import _parse_probe_manifest, run_review_and_fix
from review.probes import Probe, collect_probes, js_run_name, run_probes
from review.prompts import FIXER_SYSTEM_PROMPT, PROBE_WRITER_SYSTEM_PROMPT

_FAKE_VITEST = r"""#!/bin/sh
[ "$1" = "run" ] || { echo "expected 'vitest run <file>'"; exit 2; }
f="$2"
[ -f vite.config.js ] || { echo "not run from the package root"; exit 2; }
case "$f" in
  *.test.js|*.test.jsx|*.test.ts|*.test.tsx) ;;
  *) echo "No test files found, exiting with code 1 (include: **/*.test.*)"; exit 1 ;;
esac
[ -f "$f" ] || { echo "No test files found: $f"; exit 1; }
dir=$(dirname "$f")
for m in $(sed -n "s/.*from '\(\.[^']*\)'.*/\1/p" "$f"); do
  ls "$dir/$m".* >/dev/null 2>&1 || [ -f "$dir/$m" ] ||
    { echo "Failed to resolve import \"$m\""; exit 1; }
done
want=$(sed -n 's/.*expects: \(.*\)$/\1/p' "$f")
if grep -rqF "$want" src --exclude-dir=__probes__; then echo " Test Files  1 passed (1)"; exit 0; fi
echo "AssertionError: expected the page to contain \"$want\""
exit 1
"""


def _probe_source(expects: str, import_path: str = "../App") -> str:
    return (
        "import { render, screen } from '@testing-library/react'\n"
        f"import App from '{import_path}'\n"
        f"// expects: {expects}\n"
        f"test('shows {expects}', () => {{\n"
        "  render(<App />)\n"
        f"  expect(screen.getByText('{expects}')).toBeTruthy()\n"
        "})\n"
    )


def _git(repo: Path, *args: str) -> str:
    env = {
        "GIT_AUTHOR_NAME": "Test",
        "GIT_AUTHOR_EMAIL": "test@example.com",
        "GIT_COMMITTER_NAME": "Test",
        "GIT_COMMITTER_EMAIL": "test@example.com",
    }
    return subprocess.run(
        ["git", *args], cwd=repo, capture_output=True, text=True, env=env, check=True
    ).stdout


def _make_factory_shop(repo: Path, *, install: bool = True) -> None:
    frontend = repo / "frontend"
    (frontend / "src").mkdir(parents=True)
    (frontend / "package.json").write_text(
        '{"name": "frontend", "scripts": {"test": "vitest run"},'
        ' "devDependencies": {"vitest": "^2.0.0", "@testing-library/react": "^16.0.0"}}\n',
        encoding="utf-8",
    )
    (frontend / "vite.config.js").write_text(
        "export default { test: { environment: 'jsdom', globals: true } }\n", encoding="utf-8"
    )
    (frontend / "src" / "App.jsx").write_text(
        "export default function App() {\n  return <a href='/'>Continue shopping</a>\n}\n",
        encoding="utf-8",
    )
    infra = repo / "infra"
    infra.mkdir()
    (infra / "package.json").write_text(
        '{"name": "infra", "scripts": {"build": "tsc"}, "devDependencies": {"typescript": "^5"}}\n',
        encoding="utf-8",
    )
    if install:
        _install_fake_vitest(frontend)


def _install_fake_vitest(package: Path) -> None:
    bin_dir = package / "node_modules" / ".bin"
    bin_dir.mkdir(parents=True)
    vitest = bin_dir / "vitest"
    vitest.write_text(_FAKE_VITEST, encoding="utf-8")
    vitest.chmod(vitest.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


@pytest.fixture
def shop(tmp_path: Path) -> Path:
    repo = tmp_path / "factory-shop"
    repo.mkdir()
    _make_factory_shop(repo)
    return repo


def _probe(filename: str, source: str, package_dir: str = "") -> Probe:
    return Probe(
        id=Path(filename).stem,
        intent="x",
        filename=filename,
        source=source,
        package_dir=package_dir,
    )


class TestCollect:
    def test_collects_js_probes_flat_and_in_package_subdirs(self, tmp_path: Path) -> None:
        (tmp_path / "frontend").mkdir()
        (tmp_path / "test_flat.jsx").write_text("a", encoding="utf-8")
        (tmp_path / "frontend" / "cart.test.jsx").write_text("b", encoding="utf-8")
        (tmp_path / "test_py.py").write_text("c", encoding="utf-8")
        (tmp_path / "notes.md").write_text("not a probe", encoding="utf-8")
        probes = collect_probes(str(tmp_path), intents={"frontend/cart.test.jsx": "cart link"})
        assert {(p.package_dir, p.filename) for p in probes} == {
            ("", "test_flat.jsx"),
            ("frontend", "cart.test.jsx"),
            ("", "test_py.py"),
        }
        assert next(p for p in probes if p.filename == "cart.test.jsx").intent == "cart link"

    def test_manifest_names_js_probes_with_package_paths(self) -> None:
        manifest = (
            "PROBES:\n- frontend/cart.test.jsx: shows the link\n"
            "- `test_href.jsx`: links home\n- test_gcd.py: gcd(0, n) == n\n"
        )
        assert _parse_probe_manifest(manifest) == {
            "frontend/cart.test.jsx": "shows the link",
            "test_href.jsx": "links home",
            "test_gcd.py": "gcd(0, n) == n",
        }


class TestRunJsProbes:
    def test_passing_probe_runs_in_the_package_and_passes(self, shop: Path) -> None:
        [result] = run_probes(
            [_probe("cart.test.jsx", _probe_source("Continue shopping"))], str(shop)
        )
        assert result.runnable is True
        assert result.passed is True, result.output
        assert result.run_path == "frontend/src/__probes__/cart.test.jsx"

    def test_failing_probe_fails_with_the_runners_output(self, shop: Path) -> None:
        [result] = run_probes([_probe("cart.test.jsx", _probe_source("Checkout now"))], str(shop))
        assert result.runnable is True
        assert result.passed is False
        assert result.failed is True
        assert "AssertionError" in result.output

    def test_observed_test_prefix_name_is_renamed_so_vitest_finds_it(self, shop: Path) -> None:
        # What the probe writer actually wrote on 01M83JHCQ68D4ETPV9KD446ZJ7.
        name = "test_continue_shopping_href.jsx"
        [result] = run_probes([_probe(name, _probe_source("Continue shopping"))], str(shop))
        assert result.passed is True, result.output
        assert result.run_path == "frontend/src/__probes__/test_continue_shopping_href.test.jsx"
        assert js_run_name("x.spec.tsx") == "x.spec.tsx"

    def test_bad_relative_import_is_a_failed_probe_not_a_skip(self, shop: Path) -> None:
        source = _probe_source("Continue shopping", import_path="../components/Missing")
        [result] = run_probes([_probe("cart.test.jsx", source)], str(shop))
        assert result.runnable is True
        assert result.passed is False
        assert "Failed to resolve import" in result.output

    def test_explicit_package_subdir_is_used(self, shop: Path) -> None:
        probe = _probe("cart.test.jsx", _probe_source("Continue shopping"), package_dir="frontend")
        [result] = run_probes([probe], str(shop))
        assert result.passed is True, result.output

    def test_temporary_copy_is_removed_after_the_run(self, shop: Path) -> None:
        run_probes([_probe("cart.test.jsx", _probe_source("Continue shopping"))], str(shop))
        assert not (shop / "frontend" / "src" / "__probes__").exists()

    def test_an_already_committed_probe_at_the_same_path_is_restored(self, shop: Path) -> None:
        probes_dir = shop / "frontend" / "src" / "__probes__"
        probes_dir.mkdir()
        committed = probes_dir / "cart.test.jsx"
        committed.write_text("// committed in an earlier round\n", encoding="utf-8")
        run_probes([_probe("cart.test.jsx", _probe_source("Continue shopping"))], str(shop))
        assert committed.read_text(encoding="utf-8") == "// committed in an earlier round\n"

    def test_python_probes_still_run_with_pytest(self, shop: Path) -> None:
        source = "def test_ok():\n    assert True\n"
        [result] = run_probes([_probe("test_ok.py", source)], str(shop))
        assert result.passed is True
        assert result.run_path == ""


class TestNotRunnable:
    def _only(self, probes: list[Probe], repo: Path):
        [result] = run_probes(probes, str(repo))
        assert result.runnable is False
        assert result.passed is False
        assert result.failed is False  # neither passed nor failed
        return result

    def test_runner_not_installed(self, tmp_path: Path) -> None:
        repo = tmp_path / "shop"
        repo.mkdir()
        _make_factory_shop(repo, install=False)
        result = self._only([_probe("cart.test.jsx", _probe_source("Continue shopping"))], repo)
        assert "`vitest` is not installed for `frontend`" in result.output
        assert not (repo / "frontend" / "src" / "__probes__").exists()

    def test_no_package_with_a_runner(self, tmp_path: Path) -> None:
        repo = tmp_path / "py-only"
        repo.mkdir()
        (repo / "app.py").write_text("x = 1\n", encoding="utf-8")
        result = self._only([_probe("cart.test.jsx", "x")], repo)
        assert "no package in the repo depends on vitest or jest" in result.output

    def test_package_without_a_runner(self, shop: Path) -> None:
        result = self._only([_probe("stack.test.ts", "x", package_dir="infra")], shop)
        assert "`infra` has no package.json that depends on vitest or jest" in result.output

    def test_ambiguous_package(self, shop: Path) -> None:
        web = shop / "web"
        web.mkdir()
        (web / "package.json").write_text('{"devDependencies": {"jest": "^29"}}', encoding="utf-8")
        result = self._only([_probe("cart.test.jsx", "x")], shop)
        assert "several packages have a test runner" in result.output

    def test_package_path_outside_the_repo(self, shop: Path) -> None:
        result = self._only([_probe("x.test.jsx", "x", package_dir="../elsewhere")], shop)
        assert "outside the repo" in result.output

    def test_unknown_probe_kind(self, shop: Path) -> None:
        result = self._only([_probe("probe_test.go", "package x")], shop)
        assert "no probe runner for .go files" in result.output


# ---- through the review backend --------------------------------------------

_SCRATCH_RE = re.compile(r"into: `(.+)`")


@pytest.fixture
def shop_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-b", "main")
    _git(repo, "config", "user.email", "test@example.com")
    _git(repo, "config", "user.name", "Test")
    _make_factory_shop(repo)
    (repo / ".gitignore").write_text("node_modules/\n", encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "base")
    _git(repo, "update-ref", "refs/remotes/origin/main", _git(repo, "rev-parse", "HEAD").strip())
    app = repo / "frontend" / "src" / "App.jsx"
    app.write_text(app.read_text(encoding="utf-8") + "// cart badge\n", encoding="utf-8")
    _git(repo, "commit", "-am", "coder change")
    return repo


def _config() -> TaskConfig:
    return TaskConfig(
        aws_region="us-east-2",
        repo_url="owner/factory-shop",
        anthropic_model="coder-model",
        task_description="In the frontend cart, add a 'Continue shopping' link.",
    )


def _write_probes(user_prompt: str, probes: dict[str, str]) -> None:
    match = _SCRATCH_RE.search(user_prompt)
    assert match is not None
    for rel, source in probes.items():
        path = Path(match.group(1)) / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(source, encoding="utf-8")


_PROBES = {
    "frontend/continue_shopping.test.jsx": _probe_source("Continue shopping"),
    "frontend/checkout_button.test.jsx": _probe_source("Checkout now"),
    "infra/stack.test.ts": "test('synth', () => {})\n",
}
_MANIFEST = (
    "PROBES:\n- frontend/continue_shopping.test.jsx: the link renders\n"
    "- frontend/checkout_button.test.jsx: a checkout button\n- infra/stack.test.ts: synth\n"
)


class TestBackendWithJsProbes:
    def _run(self, repo: Path, tmp_path: Path, fake, **kw):
        progress = MagicMock()
        with patch("runner.run_agent", new=AsyncMock(side_effect=fake)):
            result = run_review_and_fix(
                config=_config(),
                setup=RepoSetup(repo_dir=str(repo), branch="b", default_branch="main"),
                ledger=AgentInvocationLedger(),
                progress=progress,
                workspace_base_dir=str(tmp_path / "workspace"),
                **kw,
            )
        milestones = {c.args[0]: c.args[1] for c in progress.write_agent_milestone.call_args_list}
        return result, milestones

    def test_runs_commits_and_reports(self, shop_repo: Path, tmp_path: Path) -> None:
        async def fake(user_prompt, system_prompt, call_config, cwd=None, trajectory=None):
            if system_prompt == PROBE_WRITER_SYSTEM_PROMPT:
                _write_probes(user_prompt, _PROBES)
                return AgentResult(status="success", cost_usd=0.01, result_text=_MANIFEST)
            assert "NOT RUNNABLE" in user_prompt  # the code reviewer is told
            return AgentResult(status="success", cost_usd=0.01, result_text="VERDICT: READY\n")

        result, milestones = self._run(shop_repo, tmp_path, fake)

        by_key = {r.probe.key: r for r in result.probe_results}
        assert by_key["frontend/continue_shopping.test.jsx"].passed is True
        assert by_key["frontend/checkout_button.test.jsx"].failed is True
        assert by_key["infra/stack.test.ts"].runnable is False
        assert milestones["review_probes_run"] == "count=3 passed=1 failed=1 not_runnable=1"

        # Only the passing probe is committed, inside its package, where the
        # repo's own runner finds it.
        committed = "frontend/src/__probes__/continue_shopping.test.jsx"
        assert result.committed_probe_paths == [committed]
        assert committed in _git(shop_repo, "show", "--name-only", "--format=", "HEAD").split()
        assert _git(shop_repo, "status", "--porcelain").strip() == ""
        # `npm test` (vitest run) still passes with the committed probe in place.
        vitest = subprocess.run(
            ["node_modules/.bin/vitest", "run", "src/__probes__/continue_shopping.test.jsx"],
            cwd=shop_repo / "frontend",
            capture_output=True,
            text=True,
            check=False,
        )
        assert vitest.returncode == 0, vitest.stdout

        body = "\n".join(_render_round_probes_and_findings(result.rounds[0].model_dump()))
        assert "✅ PASS `frontend/continue_shopping.test.jsx`" in body
        assert "❌ FAIL `frontend/checkout_button.test.jsx`" in body
        assert "⚠️ NOT RUNNABLE `infra/stack.test.ts`" in body
        assert "1 probe(s) were written but could not be run" in body
        assert "committed to `frontend/src/__probes__/`" in body

    def test_nothing_runnable_is_reported_not_silent(self, tmp_path: Path) -> None:
        repo = tmp_path / "repo"
        repo.mkdir()
        _git(repo, "init", "-b", "main")
        _git(repo, "config", "user.email", "test@example.com")
        _git(repo, "config", "user.name", "Test")
        _make_factory_shop(repo, install=False)  # the build step installed nothing
        _git(repo, "add", "-A")
        _git(repo, "commit", "-m", "base")
        _git(
            repo, "update-ref", "refs/remotes/origin/main", _git(repo, "rev-parse", "HEAD").strip()
        )

        async def fake(user_prompt, system_prompt, call_config, cwd=None, trajectory=None):
            if system_prompt == PROBE_WRITER_SYSTEM_PROMPT:
                _write_probes(user_prompt, {"test_continue_shopping.jsx": _probe_source("x")})
                return AgentResult(status="success", cost_usd=0.01, result_text="")
            return AgentResult(status="success", cost_usd=0.01, result_text="VERDICT: READY\n")

        result, milestones = self._run(repo, tmp_path, fake, review_mode="adversarial")
        assert milestones["review_probes_run"] == "count=1 passed=0 failed=0 not_runnable=1"
        assert (
            "probes_failed=0 probes_invalid=0 probes_not_runnable=1" in milestones["review_round"]
        )
        assert result.committed_probe_paths == []
        body = "\n".join(_render_round_probes_and_findings(result.rounds[0].model_dump()))
        assert "NOT RUNNABLE `test_continue_shopping.jsx`" in body
        assert "`vitest` is not installed" in body

    def test_fixer_cannot_tamper_with_a_js_probe(self, shop_repo: Path, tmp_path: Path) -> None:
        probe_path = shop_repo / "frontend" / "src" / "__probes__" / "continue_shopping.test.jsx"
        rounds = {"n": 0}

        async def fake(user_prompt, system_prompt, call_config, cwd=None, trajectory=None):
            if system_prompt == PROBE_WRITER_SYSTEM_PROMPT:
                _write_probes(user_prompt, _PROBES)
                return AgentResult(status="success", cost_usd=0.01, result_text=_MANIFEST)
            if system_prompt == FIXER_SYSTEM_PROMPT:
                assert str(probe_path.parent) in call_config.protected_write_roots
                probe_path.write_text("test('neutered', () => {})\n", encoding="utf-8")
                return AgentResult(status="success", cost_usd=0.01, result_text="tampered")
            rounds["n"] += 1
            verdict = "READY" if rounds["n"] > 1 else "NOT-READY"
            return AgentResult(
                status="success",
                cost_usd=0.01,
                result_text=(
                    f"VERDICT: {verdict}\nFINDINGS:\n```json\n"
                    '[{"type": "issue", "severity": "major", "title": "x", '
                    '"description": "x", "evidence": "App.jsx:1"}]\n```\n'
                ),
            )

        result, _ = self._run(
            shop_repo, tmp_path, fake, review_mode="adversarial", max_iterations=2
        )
        assert result.rounds[1].reverted_probe_paths == [
            "frontend/src/__probes__/continue_shopping.test.jsx"
        ]
        assert "expects: Continue shopping" in probe_path.read_text(encoding="utf-8")
