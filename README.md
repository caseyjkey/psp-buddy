# PSP Buddy

A PSP-first desk companion built with PocketJS.

## Current milestone

- Real PSP clock and battery status
- Native PSP infrastructure Wi-Fi connection through the saved `PSP-Buddy`
  profile
- Token Monitor-driven thriving, waiting, napping, hibernating, and offline
  states
- Live 5-hour and weekly remaining meters, refreshed every 30 seconds
- Circle toggles a compact 5-hour reset view with countdown and clock time
- X triggers a manual refresh
- START toggles a persisted keep-awake mode that prevents screen-off and
  automatic suspend while PSP Buddy is open
- `tools/validate-ppsspp.sh` launches a disposable PPSSPP copy of the EBOOT;
  press Circle to exercise the offline simulation scene before hardware deploy
- Wi-Fi reconnects cleanly after a normal PSP suspend/resume cycle

## Token Monitor bridge

`bridge/` reads Gilbert's authenticated Token Monitor hub API and exposes only
the compact Buddy state at `GET /v1/buddy` on port `17322`. The PSP never gets
the Token Monitor secret or account identity.

The state is subscription-driven:

- recent Codex or OpenAI-backed OpenClaw tokens: `thriving`
- no recent usage with quota available: `waiting`
- 5-hour/session limit empty: `napping` until its reset
- weekly limit empty: `hibernating` in the cave until its reset
- Token Monitor unavailable: `offline`

Run bridge tests with `cd bridge && npm test`. On Gilbert the user service is
installed as `psp-buddy-bridge.service`; its LAN endpoint is
`http://10.0.0.93:17322/v1/buddy`.

## PSP-only Wi-Fi

Gilbert hosts an isolated legacy access point through the Alfa AWUS036NHA:

- SSID: `PSP-Buddy` (the PSK is stored only in NetworkManager and was delivered
  privately to Casey)
- 2.4 GHz channel 6, 20 MHz, WPA-PSK/TKIP
- PSP subnet: `10.42.42.0/24`
- Buddy endpoint from the PSP: `http://10.42.42.1/v1/buddy` (port 80 is
  redirected locally to the unprivileged bridge on port 17322)

The `PSP-Buddy` NetworkManager profile starts automatically. The system service
`psp-buddy-ap-firewall.service` loads `deploy/psp-buddy-ap.nft` and matching
interface-scoped iptables permits, allowing only DHCP, ICMP diagnostics, and
TCP port 17322 into Gilbert while rejecting all forwarding to the main LAN or
internet. Both firewall frontends are required because Gilbert also has an
iptables `INPUT DROP` policy. Removing the adapter leaves the main `skoden`
connection untouched; reconnecting it should reactivate the AP.

## Build

### Fast emulator loop

Install PPSSPP on Arch, then launch the latest staged build without touching
the physical PSP:

```sh
sudo pacman -S ppsspp ppsspp-assets
tools/validate-ppsspp.sh dist/EBOOT-v0.9.12-alpha.PBP
```

The script verifies the copied EBOOT hash and uses an isolated cache directory.
PPSSPP rendering is a fast validation gate; the real PSP remains the final
gate for native launch, Wi-Fi, suspend/resume, and button behavior.

The pinned PocketJS checkout currently lives at:

```text
/home/alpha/.tmp/openclaw-spikes/psp-pocketjs-hardware/pocketjs
```

Build through PocketJS's manifest pipeline:

```sh
cd /home/alpha/.tmp/openclaw-spikes/psp-pocketjs-hardware/pocketjs
bun tools/pocket.ts build --target psp \
  --manifest /home/alpha/Development/psp-buddy/pocket.json \
  --project-root /home/alpha/Development/psp-buddy \
  --outdir /home/alpha/Development/psp-buddy/dist \
  -- --release
```

The PSP host patches add the standalone utility operations plus a bounded,
fixed-endpoint Buddy transport. Apply them to a clean pinned PocketJS checkout
before building:

```sh
git apply /home/alpha/Development/psp-buddy/patches/pocketjs-psp-host.patch
install -m 0644 \
  /home/alpha/Development/psp-buddy/native/psp/buddy_net.rs \
  hosts/psp/src/buddy_net.rs
git apply /home/alpha/Development/psp-buddy/patches/pocketjs-psp-buddy-net.patch
```

The transport discovers the saved network profile by SSID rather than assuming
a connection number. A low-priority native poller owns all Wi-Fi/HTTP work and
publishes a cached snapshot to QuickJS, so a stalled request cannot freeze the
render loop. It can only request `http://10.42.42.1/v1/buddy`, caps the response
at 4 KiB, and reports a visible offline stage on failure.
