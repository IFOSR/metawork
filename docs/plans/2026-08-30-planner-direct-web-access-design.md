# Planner Direct Web Access Design

> **Status:** Accepted; implementation in progress
> **Design date:** 2026-08-30
> **Review owner:** Product / Architecture
> **Scope:** AnyFusion-Pi semantic Planner tools and action routing
> **Related authority:** ADR-0015, ADR-0020
> **Implementation plan:** `2026-08-30-planner-direct-web-access-implementation-plan.md`

## Decision

The semantic Planner receives two read-only public Web tools:

- `web_fetch` reads one credential-free public HTTP(S) URL and returns bounded
  text.
- `web_search` searches the public Web and returns a bounded list of source
  titles, URLs, and snippets.

These tools are Planner-owned information inputs. They do not create a Task,
authorize an Executor, mutate storage, write the Workspace, run a shell, or
perform an authenticated external action.

## Action Boundary

The Planner chooses actions from meaning and required effects:

| Request requirement | Planner action |
| --- | --- |
| Ordinary conversation or an answer derivable in the current turn from dialogue, read-only MetaWork queries, or read-only public Web tools | `direct_reply` |
| Missing user decision prevents one safe action | `clarification` |
| Explicit control of a known Task | `task_control` |
| Shell execution, Workspace inspection unavailable to the semantic Planner, file or Git mutation, storage mutation, authenticated/private-system access, external side effects, durable progress, artifacts, or multi-step work | `plan_work_graph` |

`direct_reply` is prohibited when the answer would claim that an unavailable
operation was performed. Public Web research remains `direct_reply` only while
it is bounded to the current Planner turn and the final output is the answer
itself. If the user asks for a durable research deliverable, downstream
handoff, repeated monitoring, or any other schedulable work, the Planner routes
to an Executor with the applicable Routing Capability.

For real-time or source-dependent factual answers, the Planner must call
`web_search` or `web_fetch` before submitting `direct_reply`. It may ask for
clarification only when one user decision is actually missing; a network/tool
failure should instead be reported accurately in a bounded direct reply unless
the user requested schedulable research work.

## Tool Boundary

The Web tools:

- accept only credential-free `http:` and `https:` targets;
- reject loopback, link-local, and private-network targets;
- pin each validated public DNS result set to that redirect hop's actual
  Undici connection, preserving hostname-based Host/TLS SNI and bypassing the
  process-global proxy dispatcher;
- use one deadline across DNS, connection setup, redirects, and response-body
  consumption, plus bounded redirects, response bytes, and output text;
- perform only `GET` requests;
- do not accept custom headers, cookies, request bodies, credentials, or
  arbitrary proxy configuration;
- expose safe metadata and source text to the Planner tool loop.

Search uses a fixed public search endpoint. The model cannot select a different
search backend or inject request headers.

## Ownership

AnyFusion-Pi owns the Web tool implementation and Planner routing instructions.
MetaWork Planning continues to own proposal validation and audit. Kernel remains
the only execution authority, and Executors remain the only components that
perform schedulable work or side effects. No Session or Kernel keyword router is
added.

## Validation

- A real AgentSession test proves semantic RPC exposes exactly the Web,
  proposal, and authoritative MCP tools but not repository, shell, edit, or
  write tools.
- Tool tests prove public fetch/search, response bounds, redirect validation,
  private-target rejection, pinned connections, and whole-operation deadlines.
- Prompt tests prove the `direct_reply` and Executor routing boundary is
  explicit.
- Existing Planner, MetaWork planning, lint, and build gates remain green.
