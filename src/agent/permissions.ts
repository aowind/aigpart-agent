// 细粒度权限策略：按工具名 + 按路径前缀控制，决定 allow / deny / ask。
import * as path from 'node:path';

export interface PermissionPolicy {
  /** 总是允许的工具名。 */
  allowTools: string[];
  /** 总是拒绝的工具名。 */
  denyTools: string[];
  /** 总是询问（需用户确认）的工具名。 */
  askTools: string[];
  /** 允许访问的路径前缀（绝对路径）。空数组 = 不限制。 */
  allowPaths: string[];
  /** 拒绝访问的路径前缀（绝对路径）。 */
  denyPaths: string[];
}

export type PermissionDecision = 'allow' | 'deny' | 'ask';

export function defaultPolicy(cwd: string): PermissionPolicy {
  return {
    allowTools: [],
    denyTools: [],
    askTools: [],
    allowPaths: [cwd],
    denyPaths: [],
  };
}

/** 合并 config 里的部分权限配置到默认策略之上。 */
export function resolvePolicy(
  cwd: string,
  partial?: Partial<PermissionPolicy>,
): PermissionPolicy {
  const base = defaultPolicy(cwd);
  if (!partial) return base;
  return {
    allowTools: partial.allowTools ?? base.allowTools,
    denyTools: partial.denyTools ?? base.denyTools,
    askTools: partial.askTools ?? base.askTools,
    allowPaths: partial.allowPaths ?? base.allowPaths,
    denyPaths: partial.denyPaths ?? base.denyPaths,
  };
}

/** 对某个工具 + 参数（可能含 path）做权限判定。 */
export function decide(
  policy: PermissionPolicy,
  toolName: string,
  cwd: string,
  args: Record<string, unknown>,
): PermissionDecision {
  if (policy.denyTools.includes(toolName)) return 'deny';
  if (policy.allowTools.includes(toolName)) return 'allow';

  // 路径检查：对带 path 参数的文件工具
  const p = typeof args.path === 'string' ? args.path : '';
  if (p) {
    const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwd, p);
    if (policy.denyPaths.some((d) => abs.startsWith(d))) return 'deny';
    if (policy.allowPaths.length && !policy.allowPaths.some((a) => abs.startsWith(a))) {
      return 'ask'; // 越界：询问
    }
  }

  if (policy.askTools.includes(toolName)) return 'ask';
  return 'allow';
}
