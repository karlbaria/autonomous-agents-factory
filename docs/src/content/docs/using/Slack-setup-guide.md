---
title: "Slack integration setup guide"
---

This guide walks through setting up the ABCA Slack integration. Once configured, your team can submit tasks by mentioning `@Shoof` in any channel and receive real-time notifications as tasks progress.

## Prerequisites

- ABCA CDK stack deployed (see [Developer guide](/sample-autonomous-cloud-coding-agents/developer-guide/introduction)) with the `slack` feature enabled in its [deployment profile](/sample-autonomous-cloud-coding-agents/getting-started/deployment-guide#deployment-profiles) (`bgagent setup --features slack,…`)
- A Cognito user account configured (see [User guide](/sample-autonomous-cloud-coding-agents/using/overview))
- A Slack workspace where you are authorized to install apps (if your workspace requires admin approval for app installs, request it through your Slack administrator)
- AWS CLI configured with credentials for your ABCA account

## Quick start

```bash
bgagent slack setup
```

This single command handles everything: deploying the stack (if needed), generating the Slack App manifest URL, prompting for credentials, and showing the install link. Follow the on-screen instructions.

## How it works

- **@Shoof mentions**: `@Shoof fix the bug in org/repo#42` submits a task. `@Shoof research <topic> in org/repo` and `@Shoof I want to build <feature> in org/repo` run research and planning instead (see [Research a topic or plan a feature](#research-a-topic-or-plan-a-feature)). Reactions on your message show progress: :eyes: (received) → :hourglass_flowing_sand: (working) → :white_check_mark: (done)
- **DMs**: Message Shoof directly for private task submissions
- **Notifications**: Threaded messages show task_created → completed (with PR link, duration, cost). The Cancel button lets you stop a running task.
- **Multi-workspace**: Each workspace installs via OAuth and gets its own bot token

## Step-by-step setup

### Step 1: Run the setup wizard

```bash
bgagent slack setup
```

If the stack isn't deployed yet, it will offer to deploy for you.

### Step 2: Create the Slack App

The wizard outputs a URL that opens Slack's "Create New App" page with everything pre-filled (scopes, events, commands, URLs). Click the link, select your workspace, and create the app.

### Step 3: Enter credentials

The wizard prompts for three values from your new app's **Basic Information → App Credentials** page:

| Field | Format |
|-------|--------|
| Signing Secret | 32 hex characters |
| Client Secret | 32 hex characters |
| Client ID | Numeric (e.g. 12345.67890) |

![App Credentials location](/sample-autonomous-cloud-coding-agents/imgs/find-credentials.png)

Format validation catches obvious typos (wrong length, non-hex characters). If the format is wrong, it loops back to re-enter. Note: the actual values cannot be verified until the app is installed — if you paste the wrong secret by mistake, you'll get an error at install time.

### Step 4: Verify Event Subscriptions

In the Slack App dashboard, go to **Event Subscriptions**:

![Finding Event Subscriptions](/sample-autonomous-cloud-coding-agents/imgs/find-even-subscriptions.png)

1. The Request URL may show "Your URL didn't respond" — click **Retry**
2. Wait for the green "Verified" checkmark
3. Click **Save Changes**

![Event Subscriptions before](/sample-autonomous-cloud-coding-agents/imgs/enable-events-before.png)

Click **Retry** and wait for the green checkmark:

![Event Subscriptions after](/sample-autonomous-cloud-coding-agents/imgs/enable-events-after.png)

The first attempt may time out due to Lambda cold start. The retry always succeeds.

### Step 5: Install the app

The wizard outputs an OAuth install URL. Open it in your browser — do **not** use the "Install App" button in the Slack dashboard (it won't connect to your backend).

After clicking **Allow**, you'll see a success page. The bot token is now stored and Shoof can respond to messages.

### Step 6: Link your account

In Slack:
```
/bgagent link
```

In your terminal:
```bash
bgagent slack link <CODE>
```

This one-time step connects your Slack identity to your ABCA (Cognito) account. The code expires in 10 minutes.

### Step 7: Test it

In any channel where Shoof is added:
```
@Shoof fix the README typo in org/repo#1
```

You should see:
- :eyes: reaction on your message immediately
- A "Task submitted" message in the thread
- :hourglass_flowing_sand: reaction when the agent starts
- :white_check_mark: reaction and "Task completed" with a View PR button when done

## Usage

### Submit a task

Mention Shoof with a repo and description:
```
@Shoof fix the login bug in org/repo#42
@Shoof update the README in org/repo
```

For private submissions, DM Shoof directly:
```
fix the login bug in org/repo#42
```

### Research a topic or plan a feature

Two more forms choose their own workflow instead of the repo's default. Shoof reads only the start of the message (after the mention), in any letter case:

```
@Shoof research <topic> in org/repo
@Shoof I want to build <feature> in org/repo
@Shoof plan <feature> in org/repo
@Shoof plan from <Confluence page URL> in org/repo
```

- **`research …`** runs `knowledge/web-research-v1`. The write-up goes to the repo's mapped Confluence space (`bgagent confluence map`), and the completion message links the page.
- **`I want to build …`** or **`plan …`** starts with a PRD: it runs `knowledge/prd-draft-v1`, which reads the repo only to learn what the app already does (no shell, no edits, no web access, no pull request) and writes a draft PRD to the repo's Confluence space: Problem, Users, Requirements, Success criteria, Out of scope, and **Product questions** for you. The PRD is in product language: no file names, architecture or implementation. The completion message says **PRD draft ready** and links the page. After you approve the PRD, Shoof writes the technical design from it (see below).
- **`plan from <Confluence page URL> …`** treats an existing page as your PRD and goes straight to the technical design (`knowledge/feature-planning-v1`), with no PRD step: the design's Source section names the page. Shoof reads the page itself, before the task starts, and only when it is a page link (`https://<site>.atlassian.net/wiki/spaces/<KEY>/pages/<id>/…`) on your Confluence site, in the space the repo is mapped to (for `karlbaria/factory-shop`, `SD`). Any other link, another space, a page it can't read, or a page the content guardrail blocks gets a reply saying why, and no task. A page longer than 8,000 characters is used up to its first 8,000, and Shoof says so in the thread. Text after the link (`@Shoof plan from <URL>, mobile first in org/repo`) goes along as your note. The page's text is passed to the design run as data: instructions written in the page are not followed.

Neither a PRD nor a design task creates a Jira card, even on a project mapped with `--auto-track`; `bgagent watch` shows the skip.

All of these need a repo: name it as `org/repo`, or mention Shoof in a channel with a default repo (`bgagent slack onboard-channel`). Without one, Shoof replies with what's missing. A message that only mentions these words later on (for example `@Shoof planning is broken in checkout in org/repo`) is an ordinary coding task.

### Approve a PRD

The **PRD draft ready** message has **Approve PRD** and **Cancel** buttons. Only the person who asked can use them; anyone else who clicks gets a private reply saying so. The buttons work for 7 days.

- **Edit the PRD in Confluence first** if you need to. Approve PRD reads the page as it is when you click.
- **Answer the product questions.** Each is a `Q<n>` heading under **Product questions**, followed by an `Answer:` line. Write your answer after `Answer:` (or in the paragraph under it). A question with nothing after `Answer:`, or only `TBD`, counts as unanswered. Delete a question if it doesn't apply, and if none are left, write `None.`
- **Approve PRD checks the page** and posts each problem in the thread: an unanswered question, text under Product questions that isn't a question, a page that no longer has the `factory-prd` label or has moved out of the repo's space, or a page over 60,000 characters. Fix them in Confluence and click **Approve PRD** again.
- **A passing check starts the technical design.** Shoof reads the PRD the same way as `plan from <url>` (the same space checks and content screening), starts the design task, posts "PRD approved — writing the technical design" in the thread, and marks the PRD page final (`factory-final` replaces `factory-draft`).
- **Cancel** writes no design and leaves the Confluence page as it is.

### Start the build from a technical design

The design arrives in the same thread as **Technical design ready: N stories, about $X** (about $0.50 of coding per story), with **Start** and **Cancel**. Only the person who asked can use them, for 7 days. The design has a summary, its source, what Shoof found in the code, the **Technical decisions** it made (each with a reason), the **Stories** (each with `Blocked by:`, acceptance criteria written as what users will see, and technical notes), **Questions for the PM**, and risks.

- **Engineers can edit the design in Confluence.** Technical decisions and technical notes never block Start; Shoof makes those decisions itself and asks engineers nothing.
- **Answer the questions for the PM.** They are product gaps the PRD doesn't answer, written like the PRD's product questions. An unanswered one blocks Start. (A design made before this update calls the section **Open questions**; Start reads it the same way.)
- **Start checks the design** and posts each problem in the thread: no stories, a story with no acceptance criteria, two stories with the same number or title, a `Blocked by:` that names a story that doesn't exist or forms a cycle, more than 15 stories, a page over 60,000 characters, or an unanswered question for the PM. Fix them in Confluence and click **Start** again.
- **The message is the cost confirmation.** If edits changed the number of stories since the message was posted, Start doesn't go ahead: it posts the new count and cost with a new **Start** button.
- **For now, Start only checks the design.** A passing check says "Check passed — filing arrives in the next update", and nothing is filed in Jira. Filing the stories and starting the build come in the next update.
- **Cancel** files nothing and leaves the Confluence page as it is.

Approve PRD and Start only read a page's text into a fixed list of stories, decisions and questions. Nothing in it is followed as an instruction, and nothing from it is sent to a model by the check; the design run gets an approved PRD only after the content guardrail has screened it.

### Cancel a task

Click the **Cancel Task** button in the thread while the agent is working.

### Get help

```
/bgagent help
```

### Slash commands

| Command | Purpose |
|---------|---------|
| `/bgagent link` | Link your Slack account (one-time) |
| `/bgagent help` | Show usage instructions |

## Troubleshooting

### @Shoof doesn't respond

1. Is Shoof added to the channel? Use `/invite @Shoof` or add via channel settings.
2. Were credentials entered correctly? Delete the app and re-run `bgagent slack setup`.
3. Check CloudWatch logs for the `SlackEventsFn` Lambda — look for "Invalid Slack event signature" (wrong signing secret).

### "Your Slack account is not linked"

Run `/bgagent link` in Slack, then `bgagent slack link <code>` in your terminal.

### "Repository not onboarded"

The repo must be registered with a Blueprint before submitting tasks. See the [User guide](/sample-autonomous-cloud-coding-agents/using/overview).

### OAuth install fails (bad_client_secret)

The credentials stored don't match your app. Delete the app and re-run `bgagent slack setup`, making sure to paste the correct values.

### Event Subscriptions URL doesn't verify

Click **Retry** — the first attempt times out due to Lambda cold start. The retry succeeds.

## Multi-workspace support

The integration supports multiple Slack workspaces. Each workspace admin opens the OAuth install URL from `bgagent slack setup` output. Per-workspace bot tokens are stored separately. Users in each workspace link their accounts independently.

## Removing the integration

To uninstall from a workspace: **Slack → Settings → Manage Apps → Shoof → Remove App**. The bot token is automatically scheduled for deletion.

To remove the Slack integration from your ABCA deployment entirely, delete the Slack App, then run `bgagent setup` and disable Slack. This deletes the installation, user and channel mapping tables (see [What disabling a feature removes](/sample-autonomous-cloud-coding-agents/getting-started/deployment-guide#what-disabling-a-feature-removes)).
