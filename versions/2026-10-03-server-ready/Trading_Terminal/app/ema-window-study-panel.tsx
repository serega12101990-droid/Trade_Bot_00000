import type { EmaWindowStudy } from "./ema-window-study";
import type { summarizeWindowStudies } from "./ema-window-study-stats.mjs";

const number = (value: number | null | undefined, digits = 2) => value == null ? "—" : value.toLocaleString("ru-RU", { maximumFractionDigits: digits });
const percent = (value: number | null | undefined) => value == null ? "—" : `${number(value)}%`;

export function WindowStudyStatistics({ cohorts = [] }: { cohorts?: ReturnType<typeof summarizeWindowStudies> }) {
  return <section className="research-block window-study" aria-label="Теневой тест препятствий EMA-окна">
    <header><div><p className="eyebrow">EMA-ОКНА · ТЕНЕВОЙ ТЕСТ</p><h3>Препятствия, промежуточная цель и сопровождение</h3></div><span className="readonly-badge">Без влияния на баланс</span></header>
    <p>Карта сохраняется до входа. Старые идеи без карты не пересчитываются по новым правилам.</p>
    {!cohorts.length && <p className="empty-row">Новая версия ждёт первые подтверждённые сигналы окон. Завершённых примеров пока нет.</p>}
    {cohorts.map(cohort => <article key={`${cohort.strategyId}:${cohort.version}`}>
      <h4>{cohort.label} · {cohort.version}</h4>
      <p>{cohort.observations} сигналов · {cohort.episodes} непересекающихся эпизодов · {cohort.evaluated} оценено · {cohort.waiting} ждут срока · {cohort.pendingData} ждут свечей · {cohort.unavailable} недоступны.</p>
      <p>{cohort.duplicates} дублей и {cohort.overlapping} перекрывающихся сигналов исключены из оценки преимущества. Неполных карт: {cohort.incompleteMaps}; слишком близкая преграда: {cohort.tightSpace}.</p>
      <div className="window-study-metrics">
        <span>Направление к концу срока <b>{percent(cohort.directionRatePct)}</b><small>{cohort.directionCorrect} / {cohort.evaluated}</small></span>
        <span>Касание первой цели <b>{percent(cohort.firstTargetTouchRatePct)}</b><small>{cohort.firstTargetTouched} / {cohort.firstTargetKnown}</small></span>
        <span>Касание полного окна <b>{percent(cohort.fullWindowTouchRatePct)}</b><small>{cohort.fullWindowTouched} / {cohort.evaluated}</small></span>
        <span>Признак отмены продолжения <b>{cohort.cancellations}</b><small>за горизонт наблюдения</small></span>
      </div>
      <p>Касания учитывают весь горизонт, в том числе движение после SL. Это не винрейт: результаты выходов — ниже.</p>
      <div className="research-table-wrap"><table className="research-stats-table"><thead><tr>
        <th>Выход</th><th>n / спорные</th><th>WR net</th><th>Средний net</th><th>PF net</th><th>Exp R</th><th>Δ к прежнему</th><th>Убытков снято / побед потеряно</th>
      </tr></thead><tbody>{cohort.variants.map(variant => <tr key={variant.id}>
        <td>{variant.label}<small>{variant.sampleSufficient ? "Есть 30 примеров; нужен отдельный проверочный период" : "Малая выборка"}</small></td>
        <td>{variant.evaluated} / {variant.ambiguous}</td>
        <td>{percent(variant.winRatePct)}</td><td>{percent(variant.avgNetReturnPct)}</td>
        <td>{number(variant.profitFactor)}</td><td>{number(variant.expectancyR)}</td>
        <td>{percent(variant.avgDeltaVsBaselinePct)}<small>{variant.paired} пар</small></td>
        <td>{variant.avoidedLosses} / {variant.missedWinners}<small>{variant.worsenedWinners} прибыльных ухудшено</small></td>
      </tr>)}</tbody></table></div>
    </article>)}
    <p>Net: исследовательская модель — 5 б.п. комиссии + 5 б.п. проскальзывания на каждую сторону, не тариф биржи; финансирование не учтено. Неоднозначные сделки исключены из WR/PF и парного сравнения. Корреляция разных активов остаётся; автоматического допуска стратегии нет.</p>
  </section>;
}

export function WindowStudyMap({ study }: { study: EmaWindowStudy }) {
  return <article className="window-study window-study-map">
    <h4>Теневая карта препятствий · {study.anchorTimeframe} · {study.side}</h4>
    <p>Снимок: {new Date(study.asOf).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })} МСК · {study.version}</p>
    <div className="window-study-metrics">
      <span>Прежний TP <b>{number(study.baselineTarget, 6)}</b></span>
      <span>Новый TP1 перед преградой <b>{number(study.firstTarget, 6)}</b></span>
      <span>Дальняя цель <b>{number(study.fullTarget, 6)}</b><small>{study.fullTargetLabel} · после прохода преград</small></span>
    </div>
    {study.firstTarget == null && <p>Цена уже слишком близко к преграде: варианты нового выхода недоступны. Основная торговля не блокируется.</p>}
    <ol>{study.obstacles.slice(0, 8).map(o => <li key={o.id}>{o.label}: {number(o.low, 6)}–{number(o.high, 6)}{o.id === study.firstObstacleId ? " · первая преграда" : ""}</li>)}</ol>
    {study.obstacles.length > 8 && <details><summary>Ещё преград: {study.obstacles.length - 8}</summary><ol start={9}>{study.obstacles.slice(8).map(o => <li key={o.id}>{o.label}: {number(o.low, 6)}–{number(o.high, 6)}</li>)}</ol></details>}
    {!study.obstacles.length && <p>Преграды не обнаружены в доступной истории. Это не доказательство свободного пути; TP1 совпадает с целью полного окна.</p>}
    {!!study.missingTimeframes.length && <p>Неполные или устаревшие данные: {study.missingTimeframes.join(", ")}. Отсутствие данных не означает отсутствие поддержки.</p>}
    <p>Продолжение: два закрытия 5м за каждой преградой. Отмена: возврат пробитого уровня либо встречная структура вместе с EMA20/50 и MACD 5м. Вариант трейлинга действует после TP1, только со следующей свечи.</p>
  </article>;
}
