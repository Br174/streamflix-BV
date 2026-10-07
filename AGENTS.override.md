# MotorLab bootstrap — maintainer control-plane override

1. Activate MotorLab before any substantive project response, tool use, write, build, test, recovery, or project decision.
2. The first user-visible line must be exactly: `⚙️ MotorLab rNN attivo`, where rNN matches the pinned MotorLab session release.
3. Load and apply `MOTORLAB_PROJECT_HOOK.txt`, `.motorlab/MOTORLAB_SYNC_STATE.txt`, and `.motorlab/MOTORLAB_LOCAL_CORE.txt` before substantive work.
4. Preserve the native project engine. MotorLab coordinates and never replaces domain/runtime behavior.
5. The session release is immutable until a new session or explicit verified safe-boundary handoff.
6. Unversioned MotorLab startup is invalid. Missing/unknown release identity is a bootstrap defect; never fabricate a version.
