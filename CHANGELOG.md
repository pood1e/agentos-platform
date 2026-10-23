# Changelog

## [0.28.1](https://github.com/pood1e/agentos-platform/compare/v0.28.0...v0.28.1) (2026-10-23)


### Bug Fixes

* **ci:** start release checks directly after creating the pull request ([#100](https://github.com/pood1e/agentos-platform/issues/100)) ([d916f5f](https://github.com/pood1e/agentos-platform/commit/d916f5f01f69959c68e1171b1e4ffa494977687b))

## [0.28.0](https://github.com/pood1e/agentos-platform/compare/v0.27.5...v0.28.0) (2026-10-23)


### ⚠ BREAKING CHANGES

* simplify dependencies, authorization and CI delivery ([#97](https://github.com/pood1e/agentos-platform/issues/97))

### Code Refactoring

* simplify dependencies, authorization and CI delivery ([#97](https://github.com/pood1e/agentos-platform/issues/97)) ([fe79449](https://github.com/pood1e/agentos-platform/commit/fe79449e99a88a08c9234d06fefacb6972090925))

## [0.27.5](https://github.com/pood1e/agentos-platform/compare/v0.27.4...v0.27.5) (2026-10-23)


### Bug Fixes

* restore discovery for service-scoped MCP endpoints ([#95](https://github.com/pood1e/agentos-platform/issues/95)) ([81b8350](https://github.com/pood1e/agentos-platform/commit/81b835083ed82a44e3a96561f42ca275142df582))

## [0.27.4](https://github.com/pood1e/agentos-platform/compare/v0.27.3...v0.27.4) (2026-10-23)


### Bug Fixes

* identify the singleton native egress policy in proofs ([#94](https://github.com/pood1e/agentos-platform/issues/94)) ([899685c](https://github.com/pood1e/agentos-platform/commit/899685c38742660649b96bc2f7c391c93b5e4ff4))
* pin runtime images with model workload identity ([#92](https://github.com/pood1e/agentos-platform/issues/92)) ([80381bf](https://github.com/pood1e/agentos-platform/commit/80381bff6f52301d5018e91214488295e1061575))

## [0.27.3](https://github.com/pood1e/agentos-platform/compare/v0.27.2...v0.27.3) (2026-10-23)


### Bug Fixes

* bind MCP origins and model requests to Actor identity ([#89](https://github.com/pood1e/agentos-platform/issues/89)) ([9999a38](https://github.com/pood1e/agentos-platform/commit/9999a383addfe68a5248693309d125b81741d0ac))

## [0.27.2](https://github.com/pood1e/agentos-platform/compare/v0.27.1...v0.27.2) (2026-10-23)


### Bug Fixes

* validate templated OAuth issuer endpoints before environment rendering ([#87](https://github.com/pood1e/agentos-platform/issues/87)) ([ee3a985](https://github.com/pood1e/agentos-platform/commit/ee3a9853bc1361a5e25aa2537c8f62c207dc39e6))

## [0.27.1](https://github.com/pood1e/agentos-platform/compare/v0.27.0...v0.27.1) (2026-10-23)


### Bug Fixes

* preserve release-please generated manifest formatting ([#84](https://github.com/pood1e/agentos-platform/issues/84)) ([bfbc1bf](https://github.com/pood1e/agentos-platform/commit/bfbc1bf43cb71874a0de2da26af128ae543b3f11))

## [0.27.0](https://github.com/pood1e/agentos-platform/compare/v0.26.5...v0.27.0) (2026-10-23)


### ⚠ BREAKING CHANGES

* remove embedded evaluations and shared observability sessions

### Features

* automate immutable platform releases ([#78](https://github.com/pood1e/agentos-platform/issues/78)) ([5b909bd](https://github.com/pood1e/agentos-platform/commit/5b909bd59f8fd009b11c8506bb65a5285deceb3a))
* automate immutable releases with release-please and typed manifests ([ad6e288](https://github.com/pood1e/agentos-platform/commit/ad6e288d2cebdfffc51293d823d9d788c73dae1e))
* 自动版本与内网制品发布 ([5b909bd](https://github.com/pood1e/agentos-platform/commit/5b909bd59f8fd009b11c8506bb65a5285deceb3a))


### Bug Fixes

* compare runtime changes against main on new CI branches ([e5fce3c](https://github.com/pood1e/agentos-platform/commit/e5fce3cd0e9e99f963ab730b13608622938b67be))
* include release validation dependencies in contract builds ([9de0279](https://github.com/pood1e/agentos-platform/commit/9de0279dc7131479593dd95e5bb4b68cd2f485f9))
* include release validation dependencies in contract builds ([b13c82a](https://github.com/pood1e/agentos-platform/commit/b13c82a916b08cf8a5f0c1fe74a244bf0ae8261a))
* invalidate Python environments when included requirements change ([9db597c](https://github.com/pood1e/agentos-platform/commit/9db597c1c1473415a6255ffe72770cce49e6ceb9))
* keep delegated work active until native continuation completes ([8a5d5d7](https://github.com/pood1e/agentos-platform/commit/8a5d5d7af9a81d324fbb64bb4276e37fd752ca95))
* keep delegated work active until native continuation completes ([2d95e6b](https://github.com/pood1e/agentos-platform/commit/2d95e6b506a99d682f6b1149162883dac1693d59))
* load native runner network settings for source synchronization ([dcaee52](https://github.com/pood1e/agentos-platform/commit/dcaee52ff323dbcad9ed444391cdfb97d314716e))
* load runner network settings for source synchronization ([9be09d4](https://github.com/pood1e/agentos-platform/commit/9be09d4ffce9c5a874580620bdffcdac45f8dd61))
* stabilize private source synchronization and runtime CI selection ([#81](https://github.com/pood1e/agentos-platform/issues/81)) ([9be09d4](https://github.com/pood1e/agentos-platform/commit/9be09d4ffce9c5a874580620bdffcdac45f8dd61))
* synchronize release sources from the private build network ([ddfc2b4](https://github.com/pood1e/agentos-platform/commit/ddfc2b4d3103847e4991465aa6c5f6e697771d15))
* trigger native build pipelines through a scoped repository mirror key ([12261d4](https://github.com/pood1e/agentos-platform/commit/12261d41ab21083ddc40bcaea0bd7061ae6f526d))
* validate workload boundaries with native chart policies ([#83](https://github.com/pood1e/agentos-platform/issues/83)) ([12a287b](https://github.com/pood1e/agentos-platform/commit/12a287ba7d37a019e6212bfd9d0572dca61921d4))


### Code Refactoring

* remove embedded evaluations and shared observability sessions ([1c4b808](https://github.com/pood1e/agentos-platform/commit/1c4b8089d2af5dba07a164b175d26a5cf5e70bc7))
