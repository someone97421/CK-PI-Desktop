// 配置层（src/shared 单一来源，浏览器 bundle 与桌面 shared-core 共用）：
// 配置的读取/合并/校验收敛在 host（src/host/config.ts 的 readAllConfig，经
// GET /dsh-pet-7340/config 暴露成品）；本模块只做一件事：把**成品聚合**
// （{ main: {...}, test1: {...}, ... }，字段已填满、绝对正确）拍平成渲染用宠物列表，
// 条目级字段（animations / animationWeights / eventsRefreshSec / physics）吹进每只实例。
import type { Animations, CharacterProfile, Pet, PetDisplay, PhysicsParams, Weights } from './types';

/** 显示位置白名单 */
export const PET_DISPLAYS: PetDisplay[] = ['web', 'desktop', 'both', 'none'];

/** 该宠物是否参与浏览器 overlay 渲染 */
export const isWebVisible = (display: PetDisplay): boolean => display === 'web' || display === 'both';

/** 该宠物是否参与桌面模式（Electron 透明窗）渲染 */
export const isDesktopVisible = (display: PetDisplay): boolean => display === 'desktop' || display === 'both';

/** 默认角色（旧配置没有 character 字段 → 女仆，行为与升级前完全一致） */
export const DEFAULT_CHARACTER = 'maid';

/** 取角色档案：pets[i].character 为空按默认角色处理；角色档案缺失（id 写错/该角色未配置）
 *  时返回 null，由调用方回落条目级字段（不静默换成别的角色）。 */
export function characterProfileOf(
  conf: Record<string, unknown>,
  character: string | undefined,
): CharacterProfile | null {
  const id = typeof character === 'string' && character ? character : DEFAULT_CHARACTER;
  if (id === DEFAULT_CHARACTER) return null;
  const table = conf?.characters;
  if (!table || typeof table !== 'object') return null;
  const profile = (table as Record<string, CharacterProfile>)[id];
  return profile && typeof profile === 'object' ? profile : null;
}

/** 把 host 的成品聚合拍平成渲染用宠物列表：
 *  条目级字段（animations / animationWeights / eventsRefreshSec / physics——合并器已填默认）吹进每只实例；
 *  宠物带 character 时，先用 characters.<id> 的档案覆盖这些字段（未写的字段回落条目级）；
 *  assetRoot = 条目 key（= 素材根，多实例共享）；非 main 条目的实例打 extra 标记
 *  （文件宠物：设置页不可编辑、保存时排除）。 */
export function flattenConfigPets(merged: Record<string, Record<string, unknown>>): Pet[] {
  const out: Pet[] = [];
  for (const [entry, conf] of Object.entries(merged)) {
    const list = Array.isArray(conf?.pets) ? (conf.pets as Pet[]) : [];
    for (const p of list) {
      const profile = characterProfileOf(conf, p.character);
      out.push({
        ...p,
        animations: profile?.animations ?? (conf.animations as Animations | undefined),
        animationWeights: profile?.animationWeights ?? (conf.animationWeights as Weights | undefined),
        eventsRefreshSec: profile?.eventsRefreshSec ?? (conf.eventsRefreshSec as Record<string, number> | undefined),
        physics: conf.physics as PhysicsParams | undefined,
        workStatusTexts: profile?.workStatusTexts ?? (conf.workStatusTexts as string[][] | undefined),
        characterSheet: profile?.sheet,
        assetRoot: entry,
        extra: entry !== 'main',
      });
    }
  }
  return out;
}
