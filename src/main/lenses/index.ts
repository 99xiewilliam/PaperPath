import { LENS_META, type LensId } from '@shared/lenses'
import { connectionsLens } from './connections'
import { deepreadLens } from './deepread'
import { englishLens } from './english'
import { experimentLens } from './experiment'
import { limitationsLens } from './limitations'
import { methodLens } from './method'
import { methodDetailLens } from './methodDetail'
import { methodExampleLens } from './methodExample'
import { overviewLens } from './overview'
import type { Lens } from './types'
import { visualsLens } from './visuals'
import { writingLens, writingMethodLens } from './writing'
import { writingLogicLens } from './writingLogic'

/**
 * 所有分析维度。新增一个维度 = 新建一个文件 + 在这里注册 + 在 shared/lenses.ts
 * 里加元数据，不需要改任何其他地方的 prompt。
 *
 * 顺序不影响执行（runLensPipeline 是并发扇出的），只影响 UI 列表的排列。
 * 用户关掉哪些维度存在 settings.disabledLenses 里（opt-out），
 * 所以这里新增维度不用改任何用户配置就会生效。
 */
const LENSES: Lens[] = [
  overviewLens,
  deepreadLens,
  writingLens,
  writingMethodLens,
  writingLogicLens,
  englishLens,
  visualsLens,
  methodDetailLens,
  methodExampleLens,
  connectionsLens,
  experimentLens,
  methodLens,
  limitationsLens
]

const BY_ID = new Map(LENSES.map((l) => [l.id, l]))

export function allLenses(): Lens[] {
  return LENSES
}

export function getLens(id: LensId): Lens | undefined {
  return BY_ID.get(id)
}

export function defaultLensIds(): LensId[] {
  return LENS_META.filter((l) => l.defaultEnabled).map((l) => l.id)
}

/** 按维度 id 数组取 lens，过滤掉不存在的 */
export function resolveLenses(ids: LensId[]): Lens[] {
  return ids.map((id) => BY_ID.get(id)).filter((l): l is Lens => !!l)
}

export { LENS_META }
export type { Lens }
