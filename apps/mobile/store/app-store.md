# App Store listing

What goes into App Store Connect for the iOS app. Paste the fields as they are; the limits are
Apple's. Screenshots: "iPhone with Dynamic Island (medium display)", the size Apple requires,
in `store/screenshots-medium/` (1206 × 2622); the large display (1320 × 2868, optional) in
`store/screenshots/`. Taken on
an iPhone 17 Pro Max simulator along `e2e/store/review-demo.yaml` (the reviewers' path, on a
local server with the demo machine). The first version is for iPhone only
(`ios.supportsTablet: false`): no iPad screenshots are needed.

## App information

- **Name** (30): `Kovan` — if the name is taken: `Kovan: Agents in Your Pocket`
- **Subtitle** (30): `Your team's coding agents`
- **Bundle ID:** `dev.alperkayan.kovan`
- **Primary category:** Developer Tools. **Secondary:** Productivity.
- **Content rights:** the app shows content its users write (prompts, code, comments); no
  third-party content we license.
- **Age rating:** none of the questionnaire's content applies (no violence, gambling, mature
  themes, no unrestricted web browsing; links open in the browser). Messaging between users:
  yes (comments and messages inside a workspace's members only). Result: 4+ (Apple may set 9+
  for user-to-user messaging).
- **Privacy policy URL:** `https://kovan.alperkayan.dev/privacy/`
- **Support URL:** `https://kovan.alperkayan.dev/contact/`
- **Marketing URL:** `https://kovan.alperkayan.dev/`
- **Price:** free. No in-app purchases (models paid through Kovan are billed on the web to the
  person, or to their organization when it pays for its members; never sold in the app).

## Version text

**Promotional text** (170):

> Watch your team's AI coding agents work, answer their questions and approvals, and steer
> them from your phone. Your code keeps running on your own computers.

**Description** (4000):

> Kovan is a shared workspace where a team and its AI coding agents build software together.
> The work runs on your computers and your team's machines; Kovan on iPhone keeps you in it
> when you're away from your desk.
>
> SEE WHAT'S RUNNING
> Every live session in your workspaces, with each person's and each agent's lane streaming as
> it happens: what the agent read, ran and changed, and why.
>
> ANSWER WHAT NEEDS YOU
> Approvals ("may I run this?"), questions from agents, tasks waiting for a yes and swarms that
> paused themselves collect in one "Needs you" list. Answer from a notification or the app.
>
> STEER AND START WORK
> Message your agent while it works, ask an AI teammate for something, open a new session on a
> new branch, or set up a swarm of agents with a goal and a budget. The work starts on your
> desktop or on your team's machine.
>
> REVIEW CHANGES
> Read a session's live diff file by file, leave comments on a line and answer your team's.
>
> KNOW WHAT IT COSTS
> Spend per session, per model and per workspace, and the monthly spending limits your
> workspace's owner sets.
>
> Kovan on iPhone doesn't run agents or edit code itself: it watches, answers and steers. You
> need a Kovan account and the Kovan desktop app (macOS, Windows, Linux), or a computer of your
> team's set up to run agents, for the work to run on.

**Keywords** (100):

`ai,agents,coding,code review,developer,team,git,claude,codex,approvals,swarm,ide,devtools`

**What's new** (first version): `First release.`

## App Privacy ("Data types")

Collected, linked to the person, not used for tracking:

| Data                                                                      | Type in Apple's list              | Why                               |
| ------------------------------------------------------------------------- | --------------------------------- | --------------------------------- |
| Name, email address                                                       | Contact Info                      | App functionality (the account)   |
| User ID                                                                   | Identifiers                       | App functionality                 |
| Device ID (the push token)                                                | Identifiers                       | App functionality (notifications) |
| What people write: prompts, comments, messages                            | User Content → Other User Content | App functionality                 |
| Crash data (only if the person turns error reports on in the desktop app) | Diagnostics                       | App functionality                 |

Not collected: location, contacts, browsing history, purchases, financial info, health. No
third-party advertising or analytics SDKs. Tracking: **No**.

## Sign-in for review (App Review Information)

- **Sign-in required:** yes.
- **User name:** the `REVIEW_ACCOUNT_EMAIL` on the server.
- **Password:** the `REVIEW_ACCOUNT_PASSWORD` on the server (`secrets/app-review.txt` on the
  release Mac has both).
- **Attachment:** `store/review-demo.mp4` (1 min 43 s): the path below on an iPhone simulator,
  from launching a swarm to its diff.
- **Notes:**

> Kovan is the phone companion of a desktop coding tool: agents run on computers, the phone
> watches and steers them.
>
> To sign in: tap "Other ways to sign in", type the review email in the page that opens and
> tap "Continue with email". For this one account the page asks for the password instead of
> sending an email. (Sign in with Apple works too, but a new Apple account starts with no
> workspace to look at.)
>
> The review account is in the "Kovan Demo" workspace (a small sample shop with tests),
> connected to a demo machine that runs agents for it, so work started from the phone really
> runs:
>
> 1. Open "Kovan Demo", tap "New session", type a title (for example "Sales tax") and tap
>    "Start".
> 2. In the session, open the "Swarm" tab and type a goal, for example "Add taxCents(cart,
>    ratePercent) that rounds to the nearest cent, with a test". Tap "Suggest a team", then
>    "Launch". The app says "Started on demo machine."
> 3. Within half a minute the agents start: "Lanes" streams what each one reads, runs and
>    changes, "Tasks" shows the plan, "Swarm" the team's chat and the final report, and
>    "Changes" the resulting diff once it is done (a few minutes).
>
> Earlier sessions are under "History" in the workspace. (A first prompt typed in "New
> session" goes to the person's own desktop app, which reviewers don't have; the swarm runs
> on the demo machine instead.)
>
> The demo machine's agents can only work in a sample repository and spend at most a few
> dollars a month. Account deletion: Account → "Delete account…" (deleting the review account
> removes its access to the demo workspace; please tell us if you need it restored).

## Screenshot captions

The screenshots go out with a one-line caption each, set above the screen in the frame (Apple
shows them small: the caption says what to look at). In `screenshots-medium/` order:

| Screenshot         | Caption                                |
| ------------------ | -------------------------------------- |
| 01-home.png        | Everything that needs you, in one list |
| 02-lanes.png       | Watch every agent work, live           |
| 03-tasks.png       | See where each task stands             |
| 04-swarm-setup.png | Give a team of AI agents one goal      |
| 05-swarm-done.png  | Done means the checks passed           |
| 06-changes.png     | Review the changes, comment on a line  |

Retake 01 with a few waiting cards (an empty home sells nothing), 04 with only the lead marked
"LEAD", and 03 and 05 after the cents change (amounts now read "$0.07", not "$0.0029").
