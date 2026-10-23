# Wayfinder Map

This context describes persistent decision maps used by people and agents to navigate work whose route is still being discovered.

## Language

**Map**:
A persistent graph that records one destination, the decisions and tickets that shape the route toward it, and their current relationships.
_Avoid_: Project, board, workspace

**Destination**:
The observable outcome that tells participants where a map is trying to arrive.
_Avoid_: Goal, objective, vision

**Decision**:
A settled choice that constrains later choices and changes which work is available.
_Avoid_: Answer, conclusion, resolution

**Decision Ticket**:
A bounded piece of work that begins unresolved and, once worked, retains its accepted settlement as part of the map.
_Avoid_: Issue, task, card

**Dependency**:
A prerequisite relationship in which one decision ticket must settle before another can enter the frontier.
_Avoid_: Link, connection

**Frontier**:
The complete set of open, unclaimed decision tickets whose prerequisite tickets are all settled and which can therefore be worked now.
_Avoid_: Backlog, queue, next steps

**Claim**:
A current reservation of one open decision ticket by one claimant. A claimed ticket is excluded from the frontier until the claim is released or the ticket is settled.
_Avoid_: Assignment, lock

**Claimant**:
The distinct work-session identity that holds a claim. It distinguishes concurrent work sessions, not user accounts or authenticated principals.
_Avoid_: Owner, user, client, actor

**Fog**:
In-scope uncertainty that is not yet precise enough to become a decision ticket. It becomes one or more decision tickets only when earlier decisions make the questions sharp.
_Avoid_: Backlog, deferred ticket, unknown scope

**Scope Exclusion**:
An item deliberately ruled beyond a map's destination. It never enters the frontier unless the destination is changed through a new planning effort.
_Avoid_: Fog, deferred work, rejected ticket

**Evidence**:
A compact, attributable fact or observation used to support a decision without copying the full source conversation.
_Avoid_: Context, note, transcript

**Settlement**:
The accepted result that closes one decision ticket. Its outcome is a decision, finding, or completion according to the ticket's type.
_Avoid_: Status update, transcript, closure note

**Finding**:
The accepted factual result of a research decision ticket. It synthesizes evidence for later decisions without presenting itself as a choice.
_Avoid_: Decision, raw evidence, research transcript

**Completion**:
The accepted record that the manual work required by a task decision ticket is finished, including any resulting facts needed by later tickets.
_Avoid_: Decision, progress update, activity log

**Reference**:
A portable pointer to a source or artifact outside the map. It locates supporting material without copying that material into the map.
_Avoid_: Evidence, attachment, embedded document

**Provenance**:
Structured metadata describing how accepted map content was produced and which source session or artifact it came from. Mutation actor, client, and time belong to the revision that introduced it.
_Avoid_: Transcript, activity log, audit log, revision metadata

**Revision**:
An immutable record of one accepted map change, including its authoring client, prior revision, and semantic summary.
_Avoid_: Save, version, snapshot

**Grilling Session**:
A bounded interview that works through a decision tree in frontier order and periodically checks for convergence.
_Avoid_: Brainstorm, questionnaire

**Recovery Bundle**:
A portable JSON and Markdown package containing accepted offline changes that can be reviewed and imported after service recovery.
_Avoid_: Backup, cache, queue

**Share Link**:
A revocable, optionally expiring capability that grants read-only access to one rendered map.
_Avoid_: Public map, invite
