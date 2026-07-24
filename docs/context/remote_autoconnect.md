# Remote auto-connect

Referenced from `CLAUDE.md`.

A remote project connects **on demand** (the pill's connection lamp opens the
`RemoteConnectDialog`) — *unless* it opts into `remote.auto_connect`, which
connects it on launch and on activation and **never prompts**. The toggle is only
offered when that promise can be kept: a saved SSH password, or a host the backend
recorded as `remote.key_auth` (it authenticated with no password at all). Whether
the OpenVPN tunnel is needed is a property of the *network*, not the project — the
same host is often reachable directly at one site and only through the tunnel at
another — so `autoConnectRemote` (`src/stores/projects.ts`) probes (`ssh_probe`)
and brings the tunnel up only when the host is genuinely *unreachable*, never when
it merely rejected a credential.

With **`connections_headless` off** the promise is kept differently, because it
cannot be kept that way at all: Eldrun persists no passwords in that mode, so the
eligibility gate above can never pass and auto-connect used to reject every project
and do nothing, silently. There, "auto-connect" means what it means for a tunnel
armed in the header (`lib/vpnAutoConnect`): the connect command opens in the **root
terminal** for the user to authenticate, and the pool then rides the ControlMaster
that login leaves behind (`autoConnectInteractive` → `pollRootLoginReady`, the
store-side twin of the Connect dialog's `pollSshReady`). No *modal* is raised on
either path — that is the invariant; a saved credential is only how the headless
path achieves it. The toggle is correspondingly ungated in that mode, and the probe
still decides the VPN: reachable-but-rejected is the normal state of a password host
there and must never be read as "this network needs the tunnel". When the host *is*
genuinely unreachable and the project carries a `.ovpn`, non-headless auto-connect
surfaces the **tunnel's** login in the root terminal too — but it must **never** mark
the machine-wide tunnel `"connecting"` or poll it from this path. A tunnel is
machine-wide and its lamp is shared, so an *unattended* project poll that resolves
late (or not at all, on a switch-away) strands the header on a phantom `"connecting"`
— which `VpnIndicator`'s Disconnect refuses to touch (disabled while connecting) and
the Connect dialog reads as a live tunnel (`anyVpnLive`), so the tunnel is at once
un-stoppable and un-reconnectable. The machine-wide lamp therefore has exactly one
owner that cannot strand it: `VpnIndicator`'s 10 s `refresh` reconcile, driven by the
backend's real tunnel set. Auto-connect just leaves the SSH lamp **red** and returns;
when the reconcile flips the tunnel to `connected` it fires `retryAutoConnectAfterVpn`,
which resets that red lamp and re-runs the connect — now reachable. (For the same
reason `pollVpnUp`, still used by the *manual* reconnect path, polls to a terminal
mark regardless of the active project rather than bailing mid-handshake.) Because the
login tab **is** the connection on that path, closing it is an outcome of its own
(`"closed"`, distinct from `"timeout"`): the lamp goes back to *disconnected*, not
red, since the re-attempt guard only fires from `"off"` — a red lamp would read a
deliberate dismissal as a failure and wedge the project shut. The root-terminal
dedupe (`lib/remoteConnect`) expires with the tab for the same reason: it now maps
each key to the tab carrying it, so a closed login stops claiming the key and the
next activation offers the login again instead of waiting on a master that is never
coming. A `null` mapping is a connection another surface owns (the Connect dialog's
embedded terminal), whose lifetime stays that surface's business.
