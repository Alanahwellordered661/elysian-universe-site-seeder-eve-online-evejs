<p align="center">
  <img src="assets/readme/hero-universe-site-seeder-v1.svg" alt="Elysian Universe Site Seeder banner">
</p>

<h1 align="center">Elysian Universe Site Seeder</h1>

<p align="center">
  <strong>EVE Online Universe Site Seeder for EVE JS</strong>
</p>

<p align="center">
  <a href="https://github.com/JohnElysian/elysian-universe-site-seeder-eve-online-evejs/actions/workflows/ci.yml"><img alt="Build" src="https://img.shields.io/github/actions/workflow/status/JohnElysian/elysian-universe-site-seeder-eve-online-evejs/ci.yml?branch=main&label=build"></a>
  <a href="https://github.com/JohnElysian/elysian-universe-site-seeder-eve-online-evejs/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/JohnElysian/elysian-universe-site-seeder-eve-online-evejs?label=release"></a>
  <img alt="License" src="https://img.shields.io/badge/license-AGPL--3.0--or--later-2af6ff">
  <img alt="Platforms" src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-ff7aad">
</p>

<p align="center">
  <a href="#download--install"><strong>Download</strong></a>
  |
  <a href="#linux--macos-fast-path"><strong>Linux/macOS</strong></a>
  |
  <a href="#full-universe-scale"><strong>Scale</strong></a>
  |
  <a href="#the-app"><strong>Screenshot</strong></a>
  |
  <a href="#built-for-eve-js"><strong>EVE JS</strong></a>
</p>

<p align="center">
  <strong>One native GUI. One EVE JS folder. Full persistent universe site state.</strong>
</p>

<p align="center">
  A fast Rust desktop seeder for EVE JS persistent universe sites: anomalies,
  exploration families, generated mining sites, drifter sites, and
  mission-sourced dungeon authority.
</p>

<table>
  <tr>
    <td align="center"><strong>39,570</strong><br>desired universe sites</td>
    <td align="center"><strong>39,596</strong><br>runtime instances</td>
    <td align="center"><strong>8,490</strong><br>systems loaded</td>
    <td align="center"><strong>36.887s</strong><br>full local reconcile</td>
  </tr>
  <tr>
    <td align="center"><strong>6,057</strong><br>site templates</td>
    <td align="center"><strong>23</strong><br>spawn families</td>
    <td align="center"><strong>5,207</strong><br>stations loaded</td>
    <td align="center"><strong>17,179</strong><br>localized mission messages</td>
  </tr>
</table>

Elysian Universe Site Seeder is open source under `AGPL-3.0-or-later`.

## Download & Install

Windows users should download the latest release:

```text
https://github.com/JohnElysian/elysian-universe-site-seeder-eve-online-evejs/releases/latest
```

Extract `Elysian-Universe-Site-Seeder.zip`, then double-click `Install.bat`.

The installer asks for your EVE JS folder, checks Node.js, Rust, native linker
tools, disk space, and the EVE JS universe-site files it needs. It then runs a
read-only health check and opens the app.

After setup, use `StartUniverseSeeder.bat`.

## Linux & macOS Fast Path

<p align="center">
  <img src="assets/readme/unix-quickstart-v1.svg" alt="Linux and macOS quickstart">
</p>

Linux and macOS users should build the native Rust GUI from the source checkout:

```bash
git clone https://github.com/JohnElysian/elysian-universe-site-seeder-eve-online-evejs.git
cd elysian-universe-site-seeder-eve-online-evejs
chmod +x *.sh && ./Install.sh
```

Paste your EVE JS folder when asked. After setup:

```bash
./StartUniverseSeeder.sh
```

The installer tells you if the platform needs build tools such as Xcode command
line tools on macOS or build-essential/pkg-config packages on Linux.

## Full Universe Scale

<p align="center">
  <img src="assets/readme/universe-scale-v1.svg" alt="Full universe site seed scale numbers">
</p>

This is built for the big EVE JS universe state, not a toy demo.

| Dataset / operation | Result |
| --- | ---: |
| Full local reconcile | 36.887s |
| Desired persistent universe sites | 39,570 |
| Persisted runtime instances | 39,596 |
| EVE systems loaded by runtime | 8,490 |
| Stations loaded by runtime | 5,207 |
| Celestials loaded by runtime | 121,242 |
| Asteroid belts loaded by runtime | 40,928 |
| Stargates loaded by runtime | 13,970 |
| Universe spawn families | 23 |
| Site templates in authority graph | 6,057 |
| Client dungeon records | 5,417 |
| Mission records in authority data | 2,879 |
| Local dungeon runtime state | 347.56MB |
| Local dungeon authority graph | 64.26MB |
| Local sharded mining state | 97.02MB |

Numbers are from the current EVE JS universe data and the seeder's full
reconcile metadata.

## The App

<p align="center">
  <img src="assets/screenshots/universe-site-seeder-app.png" alt="Elysian Universe Site Seeder app screenshot">
</p>

The app opens in inspect mode. It shows whether the universe site state is
current, gives one clear next step, and keeps the write actions explicit.

## Install Should Be Boring

<p align="center">
  <img src="assets/readme/install-one-click-v1.svg" alt="One-click install flow">
</p>

| Step | What happens |
| --- | --- |
| `1` Run installer | Double-click `Install.bat` or run `./Install.sh`. |
| `2` Pick EVE JS | Choose the EVE JS checkout that contains `server/src/newDatabase/data`. |
| `3` Let checks run | Node.js, Rust, native linker tools, disk space, and EVE JS files are checked. |
| `4` Open the app | The seeder runs a read-only health check, then launches the GUI. |

## Built For EVE JS

<p align="center">
  <img src="assets/readme/evejs-site-flow-v1.svg" alt="EVE JS universe site seeding flow">
</p>

Elysian Universe Site Seeder is intended to work with the public EVE JS project.
It uses the EVE JS data layout and runtime services, then writes the persistent
site state that EVE JS expects.

It does not need the game server running. In fact, the seeder checks for an
active server and asks you to stop it before writing.

## What The Installer Checks

<p align="center">
  <img src="assets/readme/checks-v1.svg" alt="Installer checks">
</p>

The app only writes when you press `Seed Universe` or `Force Rebuild`. Opening
the app and running `Check Again` are read-only.

## Source Builds

The repo includes the Rust GUI source and the bundled seeder engine. Normal
Windows users should use the release zip. Developers and Linux/macOS users can
build from source with:

```bash
cargo build --release --locked
```

## License

`AGPL-3.0-or-later`

This project is not affiliated with, endorsed by, or sponsored by CCP Games.
EVE Online and related names are trademarks or registered trademarks of CCP hf.
