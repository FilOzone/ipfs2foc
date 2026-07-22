# Changelog

## [0.6.0](https://github.com/FilOzone/ipfs2foc/compare/ipfs2foc-v0.5.0...ipfs2foc-v0.6.0) (2026-07-22)


### Features

* **app:** hosted run caps and submit ETA ([55b8198](https://github.com/FilOzone/ipfs2foc/commit/55b8198ff3c8245e6c0c729c834a219f8c3e1f85))
* **app:** plausible funnel events on hosted site ([d65f978](https://github.com/FilOzone/ipfs2foc/commit/d65f978fb60f04a1542376c021876c8e40612432))
* **cli:** scarf install metrics with opt-out note ([fc076bd](https://github.com/FilOzone/ipfs2foc/commit/fc076bd65021c6e680d0a2ae7b864b2631e02170))
* recorded pull status in the status command ([128577f](https://github.com/FilOzone/ipfs2foc/commit/128577f7f2c91ef38a9cd9636448a7dabcf0ba85))


### Bug Fixes

* **app:** dedupe console union on canonical CID ([1fd26ec](https://github.com/FilOzone/ipfs2foc/commit/1fd26ec077d509347b714f92202b4280878c9380))

## [0.5.0](https://github.com/FilOzone/ipfs2foc/compare/ipfs2foc-v0.4.0...ipfs2foc-v0.5.0) (2026-07-17)


### Features

* **app:** apply the FilOz brand to the console ([92a09df](https://github.com/FilOzone/ipfs2foc/commit/92a09df4a1ef481b51ac1858a0d6b20bc16d9eac))
* **app:** bitswap rescue over browser websockets ([840d536](https://github.com/FilOzone/ipfs2foc/commit/840d53688c55b740744dd76d124c5c8d226872d8))
* **app:** carry the Filecoin Onchain Cloud brand ([df487db](https://github.com/FilOzone/ipfs2foc/commit/df487db7a51255f4fe963987ec53ddf72dfa0674))
* **app:** follow in-flight rows, 50-row pages ([1707ed0](https://github.com/FilOzone/ipfs2foc/commit/1707ed047142fcf4592c6b1238d37a36001a428b))
* **app:** hold gap-filled pieces out of submit ([f106e0a](https://github.com/FilOzone/ipfs2foc/commit/f106e0a52f0f7f52bd3090ab9774c62e460b78cf))
* **app:** learned answers keep the bitswap rescue ([82b09e0](https://github.com/FilOzone/ipfs2foc/commit/82b09e016db15b40c5ee72cbb434156e66e48b2e))
* **app:** make million-CID runs manageable ([8bd2b25](https://github.com/FilOzone/ipfs2foc/commit/8bd2b25a8de5c05d27dd9a5d9671bad2403df094))
* **app:** name the stalled phase in watchdog kills ([388c06d](https://github.com/FilOzone/ipfs2foc/commit/388c06da978be3900ad42e8b83231c805b983f71))
* **app:** page the working view, show a run ETA ([5ce1d65](https://github.com/FilOzone/ipfs2foc/commit/5ce1d65c2f9e2ce43f49b217877f99edb88ea98f))
* **app:** per-origin stream cap and stall breaker ([75b459b](https://github.com/FilOzone/ipfs2foc/commit/75b459ba8a54bdefe130d18785cfafcc4e66b956))
* **app:** pull each root from its own providers ([c4da0f9](https://github.com/FilOzone/ipfs2foc/commit/c4da0f923735102179693012bf777b53a6449e42))
* **app:** tab-level prepare concurrency override ([b338d6e](https://github.com/FilOzone/ipfs2foc/commit/b338d6ec5efccb06c301abd4cdf1f913d100d82f))
* console accepts a cids.txt file ([7079e40](https://github.com/FilOzone/ipfs2foc/commit/7079e409af83071a3ce5174acc75372b5794d633))
* relay redirect mode for free-tier hosts ([456757d](https://github.com/FilOzone/ipfs2foc/commit/456757d3406e4d41e398cb41d1d98090884f36f8))


### Bug Fixes

* **app:** close losing race generators at win time ([1107ec5](https://github.com/FilOzone/ipfs2foc/commit/1107ec546f420c5468377d9887bc0b87ad9ffb99))
* **app:** learn routing reuse from carUrls only ([407900c](https://github.com/FilOzone/ipfs2foc/commit/407900cc7e5524a8e5c7ca2df342aa3e02981af5))
* **app:** recycle bitswap node without killing wants ([e50f877](https://github.com/FilOzone/ipfs2foc/commit/e50f87769bab9a173c29060cf4d22f1a17112f35))
* **app:** skip empty answers when learning reuse ([a30747d](https://github.com/FilOzone/ipfs2foc/commit/a30747d095789f1c3ff2e033aac0c4fe70aa9aef))
* **app:** stop gating submit on the unenforced piece floor ([8eb5e92](https://github.com/FilOzone/ipfs2foc/commit/8eb5e92054cf3e367817627c16e71135c78d0a4a))
* **app:** stop killing pieces queued for a hash worker ([549812e](https://github.com/FilOzone/ipfs2foc/commit/549812e58aaa181b8027633f7c4a77b2e0503471))
* **core:** release gateway bodies on early teardown ([4424256](https://github.com/FilOzone/ipfs2foc/commit/44242566d7d7a227f4aed67395cabd1d5e5463c6))
* **core:** stop the walk when an export consumer leaves ([4326b5f](https://github.com/FilOzone/ipfs2foc/commit/4326b5fafff45b59a2aae6c9a3f759af4494804d))


### Performance Improvements

* **app:** fetch many pieces per hashing core ([bfab621](https://github.com/FilOzone/ipfs2foc/commit/bfab621d9f4ccdd2aac99c30b51c39c4dd5713e2))
* **app:** prefetch discovery ahead of the pool ([5ea5837](https://github.com/FilOzone/ipfs2foc/commit/5ea58370368e0d667e2537696ccf39f4ce3c9c3f))
* **app:** race a root's sources, staggered starts ([8e2c849](https://github.com/FilOzone/ipfs2foc/commit/8e2c849580ec7fd32c9a47b359803ebb15f7a585))
* **app:** reuse a learned routing answer per corpus ([167428f](https://github.com/FilOzone/ipfs2foc/commit/167428f0f5745099984f1a567aac8109c4f20325))

## [0.4.0](https://github.com/SgtPooki/ipfs2foc/compare/ipfs2foc-v0.3.0...ipfs2foc-v0.4.0) (2026-06-11)


### Features

* min-piece floor warns by default in pdp-submit ([5ae8ddb](https://github.com/SgtPooki/ipfs2foc/commit/5ae8ddbd41659d5c52f2f020da37c5c5923ceedc))
* quick tunnel falls back to http2 transport ([5077185](https://github.com/SgtPooki/ipfs2foc/commit/5077185a49e58c9c502f9022c6d88b32689ed4fa))
* relay rebuilds truncated gateway CARs ([09446f1](https://github.com/SgtPooki/ipfs2foc/commit/09446f18dbfd093f65eb590f0f1c0ce48fd88566))
* stall detection and per-row cancel for prepare ([eb2be62](https://github.com/SgtPooki/ipfs2foc/commit/eb2be62908f4108f7b0a2a9e7f6cfae5cd19a23c))
* verify-on-chain in the browser console ([ec006d6](https://github.com/SgtPooki/ipfs2foc/commit/ec006d6733adddacd09a26cb4b8f36331feab020))


### Bug Fixes

* late run restore no longer clobbers a live run ([ba2a931](https://github.com/SgtPooki/ipfs2foc/commit/ba2a93196a2771da6b1ae95bfbf229ad4642efae))

## [0.3.0](https://github.com/SgtPooki/ipfs2foc/compare/ipfs2foc-v0.2.0...ipfs2foc-v0.3.0) (2026-06-10)


### Features

* serve capabilities and the app from disk ([c9ac956](https://github.com/SgtPooki/ipfs2foc/commit/c9ac95680829dd5450514d537840a3651b268016))
* serve pieces from the serve daemon ([f23be37](https://github.com/SgtPooki/ipfs2foc/commit/f23be374cd22f1b48d79617d9addb8a9084550a5))
* serve submits with a session key ([ff1cff4](https://github.com/SgtPooki/ipfs2foc/commit/ff1cff49a8337396ee4bd115c4f838ac45413d9c))
* session key intake for serve ([91a68f3](https://github.com/SgtPooki/ipfs2foc/commit/91a68f3452e9ffe6aec4063420b28a3f525d3744))


### Bug Fixes

* min piece guard compared the wrong unit ([15fdc50](https://github.com/SgtPooki/ipfs2foc/commit/15fdc5012da11ceae76efb3cc04db3abc62bc831))

## [0.2.0](https://github.com/SgtPooki/ipfs2foc/compare/ipfs2foc-v0.1.0...ipfs2foc-v0.2.0) (2026-06-09)


### Features

* run manifest export, unified in core ([422760e](https://github.com/SgtPooki/ipfs2foc/commit/422760eb3e5452caf987e28059f678a49c40813a))
* import a browser run manifest into the DB ([12485be](https://github.com/SgtPooki/ipfs2foc/commit/12485be33659f6b82566f9e890bea85a18659bc9)), closes [#35](https://github.com/SgtPooki/ipfs2foc/issues/35)
* `--source-relay` to drive the shared redirect relay ([ea3c850](https://github.com/SgtPooki/ipfs2foc/commit/ea3c85011b2db8460fc97e1a3001877a3b8dfee5))
* default to trustless-gateway.link only ([ea7cbc5](https://github.com/SgtPooki/ipfs2foc/commit/ea7cbc58382c39983e96d167ba590e28eade6477))
* verified-fetch on the IPFS fallback path ([a43b08f](https://github.com/SgtPooki/ipfs2foc/commit/a43b08f7787ed3b400803dbc465c6ba728a18c54))
* serve dashboard: next-steps panel for the on-chain commit ([55a40bb](https://github.com/SgtPooki/ipfs2foc/commit/55a40bb584288669e58e12c6be34a4c7885c12d2))
* serve dashboard: state-aware controls and gas-off label ([6316faf](https://github.com/SgtPooki/ipfs2foc/commit/6316faf77c4dc776506a37edc054c0a19f1350e7))
* redesign the serve dashboard as an instrument panel ([dba6bf1](https://github.com/SgtPooki/ipfs2foc/commit/dba6bf1b78b2dff52750d35897ac75fe743a8232))


### Bug Fixes

* enable the dashboard Start button only when work is pending ([563a1ad](https://github.com/SgtPooki/ipfs2foc/commit/563a1ad0b6758b88680d1d916a6631acb8cd4a99))


### Performance Improvements

* prepare streams one CAR per root instead of one request per block ([61d7809](https://github.com/SgtPooki/ipfs2foc/commit/61d7809219ec2d597aed5f24b015a8f7f1b8f09d))
* lookahead CAR export for the IPFS fallback ([2fc9146](https://github.com/SgtPooki/ipfs2foc/commit/2fc9146c457b462d7b50977d56818d9a6d14ef30))


## [0.1.0](https://github.com/SgtPooki/ipfs2foc/compare/ipfs2foc-v0.0.1...ipfs2foc-v0.1.0) (2026-06-04)


### ⚠ BREAKING CHANGES

* full option C - INSERT-only, drop polymorphism

### Features

* add create-data-set command ([ab4f63e](https://github.com/SgtPooki/ipfs2foc/commit/ab4f63e251f2c7b548e7509e09b57e426b605501))
* analyze subcommand for persona match ([ed58793](https://github.com/SgtPooki/ipfs2foc/commit/ed58793b3969528c3ae0fadced4f261853088498))
* byte-serve assembled CARs and evict on commit ([d15e90e](https://github.com/SgtPooki/ipfs2foc/commit/d15e90e35ff695d51a7cd79d5a7a54c03aec86e3))
* cloudflared quick-tunnel ingress ([9e20786](https://github.com/SgtPooki/ipfs2foc/commit/9e207865e4ff103d45301b0644a2ecdcbfe994ac))
* example-led help, did-you-mean, next-step hints ([3f78b63](https://github.com/SgtPooki/ipfs2foc/commit/3f78b63c8648b461ccbbdbdafe3f7b4a6bac53a9))
* full option C - INSERT-only, drop polymorphism ([714b349](https://github.com/SgtPooki/ipfs2foc/commit/714b349202c35169b5b077656dc4a715d2207a53))
* helia fallback for source-gateway outages ([fdf3450](https://github.com/SgtPooki/ipfs2foc/commit/fdf3450aa939776c9cfb783e99457e91c795f396))
* node version preflight + test CI ([4e35db2](https://github.com/SgtPooki/ipfs2foc/commit/4e35db24e59a77fbec6bb1030b2a45253a6db92f))
* on-chain proof health and IPNI announcement check ([cf741db](https://github.com/SgtPooki/ipfs2foc/commit/cf741db180dd4e9afbaada4f73a6a43d179fecd6))
* option C wiring + atomic sub-piece + repack ([b9cfd6c](https://github.com/SgtPooki/ipfs2foc/commit/b9cfd6c8a356046b07c8fbb3b6188cb8ffae581f))
* pack-cars stage for multi-asset CARs ([8854c50](https://github.com/SgtPooki/ipfs2foc/commit/8854c50589f5d26bba38b7ba8d014d28c1c536c5))
* pre-submit min piece size guard ([42fab04](https://github.com/SgtPooki/ipfs2foc/commit/42fab04153e0d744173996f63a85653191ece20d)), closes [#17](https://github.com/SgtPooki/ipfs2foc/issues/17)
* report --verify HEAD-probes a sample, low-memory walk ([483f478](https://github.com/SgtPooki/ipfs2foc/commit/483f478eab0a94c0bee6cbde69812641eb501cdb))
* report full input accounting and --verify-gateway ([59f88dc](https://github.com/SgtPooki/ipfs2foc/commit/59f88dceb051d8c0a41ef21e5ccd1425f037d8f2))
* status --json + failure categories + pull-batch attempts ([68c1d60](https://github.com/SgtPooki/ipfs2foc/commit/68c1d60f999e5bc113ee8142a8ef3e9ed89afc4d))
* sub_pieces schema and member_sha256 ([8e76016](https://github.com/SgtPooki/ipfs2foc/commit/8e7601603a1af016b3dad7c264c45a1c35bab15a))
* validate numeric cli flags ([0fe7ce8](https://github.com/SgtPooki/ipfs2foc/commit/0fe7ce882b167eed63fad7394c80a10901c550c3))
* verify PiecesAdded event at commit time ([da7ed83](https://github.com/SgtPooki/ipfs2foc/commit/da7ed835dce3c7109e842bbad0d18a9a76303289))


### Bug Fixes

* addStatus must check addMessageOk and piecesAdded ([69a6686](https://github.com/SgtPooki/ipfs2foc/commit/69a6686479c8f746919e9f622fd3cbad20981635))
* bounded error listener + unlink partial CAR ([#14](https://github.com/SgtPooki/ipfs2foc/issues/14)) ([437a031](https://github.com/SgtPooki/ipfs2foc/commit/437a03114bfe7c434232168d78080db2f5a40e05))
* correct stale comments and log ([03639b7](https://github.com/SgtPooki/ipfs2foc/commit/03639b7af48b3267e6823440614a1037227c271c))
* dedup committed count + surface pack failures ([45c793f](https://github.com/SgtPooki/ipfs2foc/commit/45c793f5e355755824ddaa271b4d37fe93aa276e))
* drop webrtc from helia libp2p config ([#10](https://github.com/SgtPooki/ipfs2foc/issues/10)) ([f8a0473](https://github.com/SgtPooki/ipfs2foc/commit/f8a047303882e83e20e7c5414829dfb4d0f4e693))
* hand-build helia fallback to drop webrtc ([14e5c13](https://github.com/SgtPooki/ipfs2foc/commit/14e5c130073ed281bf51cd72a49c2f396850b383)), closes [#18](https://github.com/SgtPooki/ipfs2foc/issues/18)
* hardcode NO_PROVEN_EPOCH; constant has no getter ([71c1c75](https://github.com/SgtPooki/ipfs2foc/commit/71c1c755993f253a69c31e66480d62b42f7af6d8))
* lazy import helia to skip startup native binding ([0cf4eed](https://github.com/SgtPooki/ipfs2foc/commit/0cf4eed5eeb92583518010bf58157ce39e3ae5fb))
* make on-chain AddPieces at-most-once ([d379652](https://github.com/SgtPooki/ipfs2foc/commit/d379652044fb2ab6ef30bf15a1b1925c163f33d8))
* persist tx_hash + resume from receipt ([#12](https://github.com/SgtPooki/ipfs2foc/issues/12)) ([0ad681f](https://github.com/SgtPooki/ipfs2foc/commit/0ad681f3174769e61be535f01ee2425c92de4401))
* pin trustless-gateway CAR params ([ba4eb1f](https://github.com/SgtPooki/ipfs2foc/commit/ba4eb1fba7c44308f1bcc62f448c950f88f4b3b6))
* report bigint json + unaccountedOnChain ([#13](https://github.com/SgtPooki/ipfs2foc/issues/13)) ([cdf57b3](https://github.com/SgtPooki/ipfs2foc/commit/cdf57b3ee21668bc93c33496bdb446d1044ec281))
* report terminal CID states instead of pending ([c3b21da](https://github.com/SgtPooki/ipfs2foc/commit/c3b21dab5389c4fd7bdbac11b2160838a2740545))
* resume submitted and parked aggs ([377b398](https://github.com/SgtPooki/ipfs2foc/commit/377b3982de338c5d1718cdcf4cec765fb4d30d3c))
* set busy_timeout before WAL pragma ([#9](https://github.com/SgtPooki/ipfs2foc/issues/9)) ([a2a748c](https://github.com/SgtPooki/ipfs2foc/commit/a2a748c97593046406868acc6a391388ea80b530))
* stop silent data loss in pack/plan paths ([21b320c](https://github.com/SgtPooki/ipfs2foc/commit/21b320c015d15445f6766ee4c6fbb87266159915))
* typed network category for fetch errors ([#11](https://github.com/SgtPooki/ipfs2foc/issues/11)) ([db091e7](https://github.com/SgtPooki/ipfs2foc/commit/db091e76010b4a3097fc4c19ae7659bb5cd5c218))
