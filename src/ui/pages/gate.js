import { escapeHtml } from "../../core/text.js";
import { pageShell, link } from "../layout.js";
import { glyph, button } from "../components.js";

// 未鉴权页：不出现工具名、账号数、任何能让人判断「这是个签到面板」的信息
export function renderGate() {
  return pageShell({
    title: "访问验证",
    body: `<div class="login">
      <div class="lock">${glyph("g-lock", 22)}</div>
      <h1>此面板受密码保护</h1>
      <p>请输入访问密码</p>
      <form class="row" method="get" action="/">
        <input type="password" name="pwd" autocomplete="off" aria-label="访问密码" placeholder="••••••••">
        <button class="btn pri" type="submit">进入</button>
      </form>
      <p class="tiny" style="margin-top:14px">命令行可改用请求头 <span class="mono">X-Pwd</span> 提交</p>
    </div>`,
  });
}

export function renderUnconfigured() {  return pageShell({
    title: "未配置访问密码",
    body: `<div class="card" style="margin-top:20px">${"" }<div class="bd">
      <b style="font-size:15px">缺少环境变量 <span class="mono">PASSWORD</span></b>
      <p class="sub" style="margin:8px 0 0">平台拒绝在无口令状态下运行。设置一个即可：</p>
      <div class="cmdbox" style="margin-top:12px">npx wrangler secret put PASSWORD</div>
      <p class="tiny" style="margin-top:10px">本地开发则把它写进 <span class="mono">.dev.vars</span>（模板见 <span class="mono">.dev.vars.example</span>）。</p>
    </div></div>`,
  });
}

export function renderNotFound(pwd, text) {  return pageShell({
    title: "没有这个页面",
    body: `<div class="pane" style="margin-top:20px;text-align:center">
      <b style="font-size:15px">${text ? escapeHtml(text) : "没有这个页面。"}</b>
      <p class="sub" style="margin:8px 0 16px">路径不存在，或该工具尚未注册。</p>
      ${button(link("/", pwd), "回到总览", "pri")}
    </div>`,
  });
}

// 只有过了口令的人才看得到这里，所以直接显示原始错误信息比藏起来更有用
export function renderFatal(message) {
  return pageShell({
    title: "出错了",
    body: `<div class="card" style="margin-top:20px"><div class="bd">
      <b style="font-size:15px">请求处理失败</b>
      <p class="sub" style="margin:8px 0 0">这一轮没有任何写入。</p>
      <div class="cmdbox" style="margin-top:12px;white-space:normal">${escapeHtml(message)}</div>
    </div></div>`,
  });
}
