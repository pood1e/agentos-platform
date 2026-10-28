# AgentOS 参考部署

`agentos.platform.install` 安装平台，`agentos.platform.access` 安装环境网关，
`agentos.platform.connections` 更新环境连接，`agentos.platform.lifecycle` 识别退役身份。
角色 `agentos.platform.node_dns` 配置节点与 Pod DNS。站点通过 inventory 与变量文件提供地址、凭据及 Helm values。

安装前使用独立保存的 `cosign.pub` 校验 collection OCI 摘要、版本与源码提交。
playbook 在安装前校验 Chart 和平台镜像的同一组签名属性。发布版的默认地址、摘要和版本均已固化。

```sh
ansible-playbook agentos.platform.install -i inventory.yaml -e @site.yaml
```

站点变量与安装步骤见[构建与部署](https://github.com/pood1e/agentos-platform/blob/main/docs/delivery.md)，环境接入见[环境配置](https://github.com/pood1e/agentos-platform/blob/main/docs/environments.md)。
