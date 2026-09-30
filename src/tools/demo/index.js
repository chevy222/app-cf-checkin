// 假想的第四方工具。它存在的唯一目的：证明「加一个新工具不写内核、不写界面代码」这条承诺是真的。
// 字段形状刻意与 Qoder / Trae / WorkBuddy 都不同（多了 select、正则约束的席位号、多套餐枚举），
// 步骤数与 cost 也刻意做成会被预算闸咬到的组合（阶段 2 用）。
export default {
  id: "demo",
  name: "示例 IDE",
  order: 900,
  summary: "架构验证夹具 · 不联网、不领取任何东西",

  config: [
    {
      key: "portal",
      label: "接入点",
      type: "select",
      required: true,
      default: "cn",
      options: [
        { value: "cn", label: "国内站" },
        { value: "sg", label: "新加坡" },
      ],
      help: "验证表单引擎不止会渲染文本框；select 的取值会被白名单校验",
    },
    {
      key: "timeoutSec",
      label: "请求超时（秒）",
      type: "text",
      default: "15",
      pattern: "^[1-9][0-9]?$",
      patternMessage: "超时须为 1–99 的整数",
    },
  ],

  creds: [
    {
      key: "session",
      label: "会话票据",
      type: "textarea",
      required: true,
      secret: true,
      help: "敏感字段：12 位及以内整串隐藏，更长的只显示前后 4 位；编辑时留空表示保持原值",
    },
    {
      key: "plan",
      label: "套餐",
      type: "select",
      required: true,
      options: ["free", "pro", "team"],
    },
    {
      key: "seatId",
      label: "席位号",
      type: "text",
      required: true,
      pattern: "^[0-9A-Z]{4,16}$",
      patternMessage: "席位号须为 4–16 位大写字母或数字",
      help: "同时充当账号 uid",
    },
    {
      key: "code",
      label: "短验证码",
      type: "text",
      secret: true,
      help: "故意选一个 5–6 位的高熵短凭据：脱敏不能只验长 token，WorkBuddy 的短信码就是这种形态",
    },
  ],

  schedule: {
    resetHour: 0,
    notBeforeHour: 8,
    minIntervalSec: 1800,
    maxDaily: 10,
    backoff: [5, 15],
  },

  // 不联网，所以没有任何合法出口域名 —— 一旦有步骤试图 fetch，白名单会立刻抛错
  hosts: [],

  // cost 是「上界估算」，内核据此决定这一步这轮开不开。
  // survey(20) 故意大于「跑完一个账号后的剩余额度」，这样第二轮能观察到断点续跑。
  // 别调回 30：内核允许一步开跑之前要连收尾写入的余量一起算（runner 的 TAIL_RESERVE），
  // 30 在默认 45 的轮次里连单账号都做不完，这个夹具就观察不到"两步都做成"了。
  steps: [
    {
      id: "claim",
      label: "领取额度",
      cost: 4,
      async run() {
        return { status: "claimed", message: "领取试用额度 +50", credits: 50 };
      },
    },
    {
      id: "survey",
      label: "顺手做份问卷",
      cost: 20,
      dependsOn: ["claim"],
      async run() {
        return { status: "claimed", message: "问卷已提交 +20", credits: 20 };
      },
    },
  ],

  // 声明哪个凭据字段充当 KV 键里的 uid —— 内核据此取值，不需要为每个工具写分支
  uidField: "seatId",

  // 可选能力：界面按"有没有这个方法"决定要不要显示「测试」按钮
  async validate() {
    return { status: "ok", message: "会话票据格式有效（夹具不联网，不做真实校验）" };
  },
};
