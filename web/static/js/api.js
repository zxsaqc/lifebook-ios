// 统一数据入口。
//
// **默认走本机存储**：所有数据（含账号口令、工资等敏感内容）加密后只保存在
// 当前设备上，不联网、不依赖电脑。本机实现见 localapi.js / localstore.js。
//
// 需要改成「连自己的服务器」时，只改下面这一行 import 即可（remoteapi.js 里
// 保留了完整的前后端分离实现）。

import { api as localApi, ApiError, localIso } from "./localapi.js";

export { ApiError, localIso };
export const api = localApi;
