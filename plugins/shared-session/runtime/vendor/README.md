# Vendored dependencies

`ws/` contains the unmodified npm distribution of [ws](https://github.com/websockets/ws), version 8.22.2 (MIT; see `ws/LICENSE`). It is included so the installed plugin works without npm or an installation step. Optional native addons are not required.

Source: https://registry.npmjs.org/ws/-/ws-8.22.2.tgz

SHA-512 (base64): `/rEZ2ejown2N5gxVTHUu9bVVC7ttu0/Tgzf5hbTOixR3Fs7mbbXgn2DbdbcKgJOmpQMtrIUWivtYuVMnp/W/yA==`

`node scripts/build-plugin.mjs` copies this directory into the packaged runtime.
