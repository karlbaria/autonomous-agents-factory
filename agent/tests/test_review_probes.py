"""Tests for probe collection + the deterministic probe-run step."""

from __future__ import annotations

from pathlib import Path

from review.probes import Probe, collect_probes, run_probes


class TestCollectProbes:
    def test_reads_back_test_files_with_intents(self, tmp_path):
        (tmp_path / "test_gcd_zero.py").write_text(
            "def test_gcd_zero():\n    assert True\n", encoding="utf-8"
        )
        (tmp_path / "test_gcd_basic.py").write_text(
            "def test_gcd_basic():\n    assert True\n", encoding="utf-8"
        )
        probes = collect_probes(str(tmp_path), intents={"test_gcd_zero.py": "gcd(0, n) == n"})
        assert [p.filename for p in probes] == ["test_gcd_basic.py", "test_gcd_zero.py"]
        zero_probe = next(p for p in probes if p.filename == "test_gcd_zero.py")
        assert zero_probe.intent == "gcd(0, n) == n"
        basic_probe = next(p for p in probes if p.filename == "test_gcd_basic.py")
        assert basic_probe.intent == "probe from test_gcd_basic.py"

    def test_ignores_non_test_files(self, tmp_path):
        (tmp_path / "scratch_notes.txt").write_text("not a probe", encoding="utf-8")
        assert collect_probes(str(tmp_path)) == []

    def test_empty_scratch_dir_yields_no_probes(self, tmp_path):
        assert collect_probes(str(tmp_path)) == []


class TestRunProbes:
    def test_passing_probe_recorded_as_passed(self, tmp_path):
        probe = Probe(
            id="p1",
            intent="sanity",
            filename="test_p1.py",
            source="def test_p1():\n    assert 1 == 1\n",
        )
        results = run_probes([probe], str(tmp_path))
        assert len(results) == 1
        assert results[0].passed is True
        assert results[0].probe.id == "p1"

    def test_failing_probe_recorded_as_failed_with_output(self, tmp_path):
        probe = Probe(
            id="p2",
            intent="catches the bug",
            filename="test_p2.py",
            source="def test_p2():\n    assert 1 == 2\n",
        )
        results = run_probes([probe], str(tmp_path))
        assert results[0].passed is False
        assert "assert" in results[0].output.lower() or "failed" in results[0].output.lower()

    def test_mixed_probes_each_scored_independently(self, tmp_path):
        probes = [
            Probe(
                id="pass1",
                intent="x",
                filename="test_pass1.py",
                source="def test_pass1():\n    assert True\n",
            ),
            Probe(
                id="fail1",
                intent="y",
                filename="test_fail1.py",
                source="def test_fail1():\n    assert False\n",
            ),
        ]
        results = run_probes(probes, str(tmp_path))
        by_id = {r.probe.id: r.passed for r in results}
        assert by_id == {"pass1": True, "fail1": False}

    def test_no_probes_yields_no_results(self, tmp_path):
        assert run_probes([], str(tmp_path)) == []

    def test_temp_probe_directory_cleaned_up(self, tmp_path):
        probe = Probe(
            id="p3", intent="x", filename="test_p3.py", source="def test_p3():\n    assert True\n"
        )
        run_probes([probe], str(tmp_path))
        leftover = list(Path(tmp_path).glob(".review_probes_tmp_*"))
        assert leftover == []

    def test_unparseable_probe_source_fails_rather_than_skips(self, tmp_path):
        probe = Probe(
            id="broken",
            intent="x",
            filename="test_broken.py",
            source="def test_broken(:\n    pass\n",
        )
        results = run_probes([probe], str(tmp_path))
        assert results[0].passed is False
