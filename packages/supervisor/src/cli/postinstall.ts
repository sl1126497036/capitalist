/**
 * npm 安装后的提示。
 *
 * 只打印下一步，不写任何宿主配置：装到哪个宿主、写到哪个项目，由用户执行
 * `capitalist install` 时选择。安装阶段自动写配置会让用户失去选择权，也会把 hook 写进
 * 用户级配置，使这台机器上每个项目的每次工具调用都起一次进程。
 *
 * 失败不改变退出码：包已装好，提示缺失不应让 npm install 报错。
 */

function main(): void {
  process.stdout.write(
    "capitalist：下一步执行 capitalist install，选择要接入的宿主。\n",
  );
}

main();
