// manifest optional_host_permissions 能覆盖的 origin：https 任意主机；http 只有 localhost / 127.0.0.1（任意端口）。
// 局域网 http 端点按计划不在列表里；permissions.request 对不匹配的 origin 会直接抛错，用这个提前给出可读提示。
export function isRequestableOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol === 'https:') return true;
    if (url.protocol === 'http:') return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    return false;
  } catch {
    return false;
  }
}

export const NOT_REQUESTABLE_HINT = '该地址不在可授权范围（仅 https / localhost / 127.0.0.1），将依赖服务商的 CORS；本地模型 / 中转站可能失败';
