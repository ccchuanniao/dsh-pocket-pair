# DSH Pocket — setup guide for the user's agent

You are helping the owner of a DeepSeek Harness host use it from an Android phone.
Your job is to inspect their installation, fill in the configuration, verify it, and guide
only the steps that need the owner's account or phone. Finish a working setup, not a list
of fields for the owner to copy. Reply in the owner's language.

This is the setup procedure for both `dsh-pocket-pair` and the Android project. Keep the
Android project's copy of this file identical when changing it. The page's copyable prompt
is only an entry point; do not duplicate this procedure there.

## 1. How to work with the owner

- Inspect before asking. Find the active profile, installed plugin, ports, existing network
  entry, Android project and available Firebase configuration yourself. Reuse a working setup.
  Do not make the owner recall a port, paste four values, or explain a config you can read.
- Ask only for a real choice or an action you cannot perform: home-only versus outside access,
  creating an account, signing in, buying a service, or testing on their phone. Ask one useful
  question at a time. Give a recommendation and explain the practical tradeoff.
- When something is missing, give a next step, an official link, who does it, and what happens
  afterward. "Configure Firebase" or "get a public IP" alone is not useful guidance.
- Continue independent work while the owner completes an account step. Missing Firebase must
  not block console access. Missing an outside route must not be disguised as a working remote setup.
- Do the authorized local configuration yourself. Preserve unrelated profile entries and existing
  credentials. Do not buy a domain/VPS, enroll in billing, or expose a new public service without
  the owner's choice. Account login, MFA and terms acceptance belong to the owner.
- Keep secrets in local files or the secret store, not in chat, screenshots, public docs or Git.
  Request a local file path instead of a service account's contents. Report checks, not secret values.
- Tell the truth about verification. A local HTTP response is not a mobile-network test. A saved
  Firebase form is not a delivered notification. Never invent an address, a credential or a success.

Start with a short explanation, for example:

> 我先检查这台机器上已有的入口、插件和推送配置，能自动填的我来填。
> 如果缺账号或需要选联网方式，我只把那一步交给你；最后一起确认手机能连、通知能到。

## 2. Inspect the installation

Two parts are needed: the host plugin admits/revokes devices and sends push; the Android app
shows the host's console and receives push. The app requires Android 8 or later. FCM additionally
needs compatible Google Play services and connectivity to Google; console access does not.

1. Locate the plugin from the active Harness profile/package installation. Use its package.json,
   README and `lib/index.js` to confirm the installed version and supported fields. If only this
   Android repository is present, locate/install the host plugin before claiming setup is complete.
   Do not assume a fixed home directory, profile name, service name or npm publication status.
2. Inspect the active `cordis.patch.yml`, the service's working directory and non-secret config,
   listening sockets and relevant proxy/tunnel configuration. Avoid dumping process environments,
   launch tokens, private keys or entire state files into the conversation.
3. With an authorized local Harness session, read `GET /api/pocket-pair/state`. Obtain the session
   using the host's supported login/launch flow; do not disable authentication to get this response.
   If a session is unavailable, prepare file-based changes and ask only for the login/access needed.
4. Read `pairBase`, `apkUrl`, `lanBase`, `lanFailure`, `apkFile`, `buildEnabled`, `devices`,
   `pushConfigured`, `pushReady`, `pushFailed` and `pushTrace`. The response also includes codes and
   deployment values: keep the full response local. `pushConfigured` only means a service-account
   path was configured, not that the file, permissions or delivery work.
5. Locate the Android source, effective `applicationId`, signing identity, build output and SDK/JDK.
   Read deployment overrides as well as Gradle defaults. Never use the source namespace as proof of
   the effective applicationId. Never replace an existing signing key to make an update install.

Give a short status: what works, what is missing, and your next action. The owner does not need
an inventory of internal fields. Do not overwrite an existing working public entry with an
auto-detected LAN address.

## 3. Decide how the phone reaches the host

Treat these as separate questions:

- **Console access:** can the phone reach the host's gate over its current network?
- **Push delivery:** can the host and phone reach Google's push service?

A public IP or purchased domain is not required for Firebase. A domain by itself does not make
an unreachable host reachable. A private overlay network can provide outside access without either.

If the desired access scope is not already known, ask:

> 你希望只在家里/办公室连，还是出门用手机流量也能连？前者最省事；后者我会优先复用已有入口，
> 没有的话再帮你选一种连接方式。

### 3.1 Reuse an existing entry

Trace the route all the way to the **plugin gate**, not just the Harness web port. The gate
handles APK downloads, device authentication, push-token registration and revocation. A working
Harness browser URL alone is not proof that it reaches the gate.

Use `pairBase` as an origin (scheme, host, optional port), without a subpath, login token or query.
The app builds its requests from the origin. `apkUrl` can be a separate download URL; it is not
necessarily the address the phone uses for the console. Preserve a working APK override.

### 3.2 No outside entry: offer two paths first

> 可以先用局域网：手机和电脑在同一个可互通的网络里就能用，不需要申请域名或公网 IP；
> 离开这个网络、切到手机流量后就打不开控制台。
> 如果你需要出门也能连，我可以继续配远程入口；只有你选的方案需要账号或费用时才让你处理。

Do not tell someone who requested outside access that LAN setup completes their request.
If they choose outside access, pick the simplest suitable route based on what already exists:

| Route | Owner's part | Agent's part and limits |
| --- | --- | --- |
| Private network, such as Tailscale | Sign in; install/enable the phone client | Connect both devices to the same private network, verify access rules and the gate port, then fill the reachable private address. No purchased domain/home public IP is needed. Phone VPN/private-network connection must remain available; it can conflict with another VPN. |
| Stable HTTPS tunnel | Sign in to the chosen provider; authorize the hostname if needed | Install/configure the connector and route its public hostname to the gate. Check TLS, WebSocket and native POST requests. Requirements depend on provider; a permanent Cloudflare published hostname needs a suitable domain in the account. |
| Existing public server or home public IP | Approve any purchase, ISP request or router action you cannot perform | Configure DNS, TLS and a reverse proxy to the gate; for an internal host, configure a private tunnel from the server. Account for updates, certificates, firewall and ongoing cost. |

For a private network, use the [Tailscale quickstart](https://tailscale.com/docs/how-to/quickstart):
help the owner create/sign in to their account, add the host and phone to the same network, and
verify the host's assigned address. Use private access; do not turn on public sharing as a shortcut.
This is an option to test in their environment, not a guarantee that their carrier allows it.

For a public tunnel, use the [Cloudflare tunnel setup](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/):
the owner signs into [Cloudflare](https://dash.cloudflare.com/), selects a domain they control,
and authorizes a tunnel. You configure the connector and route to the gate. The host does not
need inbound port forwarding. Do not paste connector credentials into chat. Temporary test URLs
are not a stable pairBase. An extra browser login page may break Android's native redeem/push
requests; test those flows rather than assuming browser access is enough.

If they specifically want their own public IP/domain:

1. For a home public IP, explain that availability comes from their broadband ISP. They contact
   its official support/account portal to ask about public IPv4 or reachable IPv6, CGNAT, port
   restrictions and cost. Do not promise that every ISP grants one, or treat a router's private
   WAN address as public. IPv6 also requires a usable path from the phone.
2. For a domain, guide them to a registrar (for example [Cloudflare Registrar](https://www.cloudflare.com/products/registrar/)).
   They choose/register a name and approve payment; you then configure DNS and HTTPS for the
   chosen route. A domain purchase alone does not bypass CGNAT or open the router.
3. If the ISP route is unavailable, offer the private network or HTTPS tunnel above. A rented
   server is an alternative when they want to maintain one, not a prerequisite for this plugin.
   Check the selected provider's current pricing/requirements before asking them to purchase.

### 3.3 LAN setup

Inspect interfaces and routing; choose the LAN interface reachable by the phone. Do not blindly
use the first `lanBase` or pick a container bridge, loopback, disconnected VPN or unrelated NIC.
Use the gate's actual `lanPort` (default 8081), not the Harness port. Set `pairBase` yourself.
Check listener and firewall; keep HTTP confined to the selected trusted local/private network.
Never turn off the whole firewall or expose plaintext HTTP to the public internet to make a test pass.

Ask the owner only to connect the phone to that network and open the download URL. Guest Wi-Fi/client
isolation can block two devices even on the same Wi-Fi. A sleeping host is unavailable. If the
address changes with DHCP, explain a router reservation or another stable local addressing option.

Say **outside console access is unavailable** for LAN-only setup. Do not say that notifications
must also stop outside: after initial registration, FCM can still deliver if both sides reach
Google, although tapping the notification cannot open the LAN-only console from outside.

## 4. Configure Firebase when notifications are wanted

FCM is Firebase Cloud Messaging, not a separate account or a secret API key to buy. The owner
uses their own Google/Firebase project. FCM itself is listed as no-cost on
[Firebase pricing](https://firebase.google.com/pricing); other products and model calls may cost
money. Do not enable billing or promise all Firebase products are free.

If nothing is configured, offer:

> 通知还缺 Firebase 配置。你可以先用手机控制台，暂时没有任务完成提醒；也可以现在配通知。
> 要配的话，我带你在 Firebase 建项目，你负责登录和下载配置文件，我负责读取、填入和验证。

If the owner already asked for notifications, proceed with the setup guide instead of repeatedly
asking if they want them. Preserve existing working Firebase config. Do not disable it just because
another optional field is missing. Check phone Google Play services/connectivity early; a new
project cannot fix a phone that cannot use FCM. Offer console-only operation if FCM is unavailable;
this plugin does not currently implement a vendor-push or local-background-push replacement.

### 4.1 Owner: project and client configuration

Give only the next account step and the exact package name you discovered:

1. Open the [Firebase console](https://console.firebase.google.com/), create a project or select
   an existing one. Analytics is optional for this setup.
2. Add an **Android** app with the effective `applicationId` you provide. Keep an existing app's
   identity unchanged. Download that app's `google-services.json` and place it in an agreed local
   location you can read. Do not ask the owner to copy four fields by hand.

See [Firebase Android setup](https://firebase.google.com/docs/android/setup). DSH Pocket already
initializes Firebase from build-time values; use the downloaded file as input for extraction.
Do not automatically add the Google services Gradle plugin or commit that file into this project.

### 4.2 Agent: extract and save client values

Select `client[]` by `client_info.android_client_info.package_name == effective applicationId`.
Do not take the first client blindly. If none matches, guide the owner back to the correct Android
app registration. Require all four values; do not invent placeholders to make the form look complete.

| Plugin property | JSON source |
| --- | --- |
| `firebaseProjectId` | `project_info.project_id` |
| `firebaseSenderId` | `project_info.project_number` (keep as a string) |
| `firebaseAppId` | matching client's `client_info.mobilesdk_app_id` |
| `firebaseApiKey` | matching client's `api_key[].current_key` (confirm the intended key if ambiguous) |

These are client configuration, not the host's signing credential. See the
[official JSON field mapping](https://firebase.google.com/docs/android/google-services-plugin-and-file).
Write them through the authenticated settings API yourself and read state back. Do not publish
someone's deployment config just because it is client-visible.

### 4.3 Owner and agent: host sending credential

Client values alone are not enough. The current plugin reads a service-account JSON file; setting
an environment variable for ADC alone does not configure this implementation.

In Firebase **Project settings → Service accounts**, the owner uses **Generate new private key**
and saves the JSON securely on the Harness host. Follow the
[FCM HTTP v1 authorization guide](https://firebase.google.com/docs/cloud-messaging/send/v1-api).
Check that Cloud Messaging API (HTTP v1) is enabled in the selected project. If organization policy
blocks key creation, explain that limitation; do not bypass it or claim the current plugin supports
an alternative credential flow it has not implemented.

You verify the file is readable by the service account running Harness, restrict its permissions
(owner-only where supported), and keep it outside the repository/APK directory. Check its project
against the client project without printing `private_key`. Prefer the same project; cross-project
sending needs explicit IAM setup and is not the default onboarding route.

Set `fcmServiceAccountFile` and `pushEnabled` in the **active profile's plugin configuration**.
They are not accepted by the page's settings endpoint. Preserve other profile settings and restart
only the relevant service when needed. If Google is unreachable from the host, check DNS/TLS and
an existing authorized proxy; `fcmProxy` is a host profile option. A host proxy does not fix the
phone's Google connectivity. Keep AI summary off unless requested; basic notifications do not need it.

### 4.4 Rebuild, install and verify the whole chain

Client values are baked into the APK. Saving settings does not change an already installed APK.
Build a signed release with those values, preserve applicationId/signing key, and have the owner
install the update. On Android 13+, request notification permission. Follow the
[FCM Android requirements](https://firebase.google.com/docs/cloud-messaging/android/get-started).

After pairing, confirm that this device has `pushReady`, run a harmless short Harness task, and
check sending results in `pushTrace`/`push.log`. Ask whether the phone actually displayed the
notification. A summarize response only tests the model; `pushConfigured` only tests a setting;
FCM accepting a request does not prove phone display. If possible test with the app in background.

## 5. Write configuration correctly

Use `POST /api/pocket-pair/settings` with JSON and the authorized session. Send only fields you intend
to change, then `GET /api/pocket-pair/state` to confirm effective values. Do not ask the owner to
paste your computed values into the page. Do not edit the live `settings.json` behind the process:
it is loaded into memory and external changes may not be picked up.

| Where to write | Fields | When it takes effect |
| --- | --- | --- |
| Authenticated settings API | `pairBase`, `apkUrl`, `firebaseProjectId`, `firebaseAppId`, `firebaseApiKey`, `firebaseSenderId`, `pushAiSummary`; legacy `notifyTopic` | Page/server settings immediately; Firebase client values need an APK rebuild |
| Active profile plugin config | `lanEnabled`, `lanPort`, `lanAdvertise`, `apkDir`, `apkName`, `codeTtlSeconds`, `redeemPerMinute`, `buildEnabled`, `buildProjectDir`, `buildOutputApk`, `fcmServiceAccountFile`, `fcmProxy`, `pushEnabled`, `pushTitle`, `pushAiTimeoutMs` | Plugin reload/restart |
| Android deployment/signing config | `applicationId`, `appLinkHost`, Firebase client values, optional `pairBase`/`pairKey`; `keystore.properties` separately | Rebuild and install the APK |

Page values override profile defaults when non-empty. Clearing a string on the page falls back to
the profile, so it does **not** reliably disable a previously configured feature. Use `pushEnabled`
to stop host sending; do not claim this removes Firebase registration from an installed APK.

Install the plugin using the active profile and a source that actually resolves. **This package is not
published to npm**, so `add dsh-pocket-pair` fails — install from the repository instead:

```bash
dsh plugin --profile <profile> add github.com/<owner>/dsh-pocket-pair
```

`pnpm` accepts a short `host/user/repo` form, a full `https://` git URL, or a local directory. Run
`add --help` if you need the exact forms this Harness version supports, and read the failure rather
than assuming.

Back up changed local config. After a profile change, use the supervisor actually running Harness.
If restarting it ends your own session, arrange a supported deferred restart and leave a short
continuation note. Do not copy a made-up systemd unit or claim post-restart verification in advance.

## 6. Build and hand the phone to the owner

Check `apkFile` and the actual download first. If no signed APK exists, locate a trusted release
or the Android source and build it. Requirements are in the Android README (JDK 21, SDK API 36).
Without signing config, release output is unsigned and cannot be handed over as an installable APK.

The page builder requires `buildEnabled`, a valid `buildProjectDir`, executable wrapper and the
correct `buildOutputApk`. `POST /api/pocket-pair/build` starts work, not completion; poll `.build`
until it finishes and verify the produced file/version/signature. Do not use a stale APK after a
failed build. The current builder can mint/bake a one-time code; do not keep minting another code
while the owner is installing, because that invalidates the previous one.

A live baked code is a credential even if single-use. Do not publish that personalized APK to a
public release or treat "only one device" as protection from someone else being first. Prefer a
generic signed APK and a separate fresh pairing code for public distribution. Respect code expiry
(default one hour, read the actual `ttlSeconds`); build/download time consumes that lifetime.

**Current first-install limitation:** the QR points to an APK URL with the pairing information in
the fragment. Installing an APK from the browser does not pass that fragment to the newly installed
app. There is no implemented download-and-open landing page here. Do not promise one scan completes
installation and pairing, and do not diagnose the resulting address prompt as user error.

Use this reliable handoff:

1. Provide the verified download link and have the owner install the app.
2. Once it is installed and they are ready, use `POST /api/pocket-pair/mint` yourself. Give the fresh
   link/QR and the manual fallback: the resolved address and code. These belong in the private
   setup conversation, never in the generic copyable prompt or public docs.
3. Ask them to open the pairing link again. Automatic HTTPS interception needs working App Links:
   matching `appLinkHost`, package ID, signing fingerprint and `/.well-known/assetlinks.json`.
   LAN HTTP and unverified links may stay in the browser. In that case open the app and enter the
   address/code you supplied. Do not make App Links or buying a domain mandatory for manual pairing.
4. Verify a device appeared and the console can complete a harmless action. Keep the owner on the
   intended network for the test. For outside access, ask them to turn Wi-Fi off (and leave the
   private-network client on if used) and retry; do not call LAN success an outside-access pass.

Only the owner can do phone installation, OS permissions and tests on an inaccessible phone.
Present one next phone action at a time. Missing build credentials or permissions should produce
a precise blocked step plus the work already completed, not another configuration questionnaire.

## 7. Diagnose by evidence

Check from host to phone: listener → route/TLS → download → redemption → console/WebSocket → push.
A pre-pairing gate response of 401 is expected; it can prove reachability but not successful pairing.
Never spend the owner's fresh code as a test without replacing it. Never bypass code validation.

| Symptom | Check and action |
| --- | --- |
| State API 404 | Active profile, plugin registration/version and restart; do not recreate Firebase |
| State API 401/403 | Authorized session and correct origin; do not remove host auth |
| `lanFailure` or no listener | Port collision, plugin startup, service permissions; fix actual cause |
| Works on host but not phone | Route, correct interface, firewall, guest Wi-Fi isolation, VPN, DNS/TLS; host loopback is not the phone's address |
| Works on Wi-Fi, fails on mobile data | LAN-only address or incomplete outside route; offer section 3, not a new pairing code |
| APK URL 404 | File missing/wrong apkDir/apkName or route points to Harness instead of gate |
| Install rejected | Unsigned output, different signing identity, incompatible Android version; do not erase app data as a first step |
| Installed after scanning, now asks for address | First-install link handoff limitation; give fresh link or manual address/code |
| Code refused | Empty, expired, spent or replaced code, wrong host; mint once after fixing the route |
| Console keeps reconnecting | Inspect the actual authenticated WebSocket route and upgrade through proxy/gate; arbitrary `/` returning no 101 is not a valid test |
| `pushConfigured` false | Missing service-account path in active profile; client config alone is insufficient |
| Push configured but device `pushReady` false | APK contains matching Firebase values, Google Play services/network, token registration and device credential; inspect client errors |
| Push-token registration 401 | Request must reach gate and carry `X-Dsh-Device-Token`; browser and native HTTP do not share cookies |
| OAuth/FCM send fails | Service-account file/permissions, matching project, API enabled, IAM, host clock, Google connectivity/proxy; inspect error without printing secrets |
| Send accepted, phone silent | Notification permission/channel, phone Google connectivity, background restrictions, stale token; require a real phone test |
| Task completion creates no push attempt | `pushEnabled`, device registration, `pushTrace.sessionEvents`, agent/session IDs and `skipped`; confirm compatibility with installed Harness |
| AI summary fails | Inspect summary error/model configuration; basic push can be tested with summary off; do not conflate model success with FCM delivery |

`push.log` contains work content; `pushTrace` can contain recent assistant text. Read only what's
needed and redact it in reports. Check both plugin diagnostics and the actual supervisor logs;
do not assume every logger reaches the system journal. Turning AI summary off still sends a reply
preview in this version; turning all host push off uses `pushEnabled: false`. Do not claim a
completion-only privacy mode exists unless the installed code implements one.

For implementation debugging: session events may wrap payloads in `event.data`; inspect the installed
Harness contract before changing extraction. Declare injected services, keep optional model services
optional, and inspect terminal model errors rather than treating every empty result as success.

## 8. Finish with a usable result

Keep the final handoff short, in the owner's language:

- **Phone console:** verified / awaiting phone test / blocked, with the exact next action.
- **Access scope:** same reachable LAN only / private-network client required / verified outside HTTPS.
- **Notifications:** received on phone / configured but unverified / intentionally skipped, and why.
- **Remaining owner action:** only login/download/install/permission/test steps that remain.

Example for a chosen LAN-only, no-push setup:

> 局域网连接已经配好。手机连到和电脑可互通的 Wi-Fi 后，用下面的地址和配对码打开 App。
> 这套方案出门切手机流量就打不开控制台；电脑也要保持开机。
> 你选择暂时跳过通知，所以任务结束不会提醒。以后要加远程访问或通知，可以接着配。

If outside access or notifications were requested but remain untested, name that unfinished part.
Do not present a partial setup as complete.

## 9. API and file reference

| Route | Authorization | Purpose |
| --- | --- | --- |
| `GET /api/pocket-pair/state` | Harness session | Effective settings, codes, devices, build/push diagnostics |
| `POST /api/pocket-pair/settings` | Harness session | Partial JSON update; fields listed in section 5 |
| `POST /api/pocket-pair/mint` | Harness session | Replace the current code; returns link/QR |
| `POST /api/pocket-pair/build` | Harness session | Start configured builder; poll state |
| `POST /api/pocket-pair/close` | Harness session | Close enrollment, leave paired devices intact |
| `POST /api/pocket-pair/revoke` | Harness session | JSON `{ "device": "<device-name>" }`; revoke and close tracked connections |
| `POST /api/pocket-pair/summarize` | Harness session | JSON `{ "text": "<harmless test text>" }`; model-only test |
| `POST /dsh-pocket-pair/redeem` | Valid single-use code | Exchange `{ "code": "<code>", "device": "<name>" }` for device access |
| `POST /dsh-pocket-pair/push` | Device credential, through gate | Register device FCM token |
| `GET /apk/<name>.apk` | Public download route | Serve APK from configured apkDir |
| Other gate routes | Device credential | Proxy to Harness |

Defaults and full config schema: installed `lib/index.js` and README. Runtime files are normally
under `<DSH_HOME>/dsh-pocket-pair/`: `settings.json`, `pairing.json`, `push.log`, `apk/`.
Never commit these, service-account files, keystores, signing properties, live codes or deployment
values. Do not copy addresses or credentials from a maintainer's machine-local handoff into public
instructions. Provider links were checked on 2026-09-26; check current official instructions if
account screens or service requirements change.
