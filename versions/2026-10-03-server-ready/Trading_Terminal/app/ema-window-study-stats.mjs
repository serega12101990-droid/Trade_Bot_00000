/**
 * Shared by the journal UI and the read-only weekly audit.
 * Path touches include the whole horizon (also after SL); they are NOT wins.
 * Performance uses the first non-overlapping episode per symbol/strategy/version.
 * @param {Array<{symbol:string, market:string, timeframe:string, asofTime:number, matches:import('./terminal-types').ForecastStrategyMatch[]}>} records
 * @returns {import('./ema-window-study').WindowStudyCohort[]}
 */
export function summarizeWindowStudies(records) {
  const groups = new Map();
  const seen = new Set();
  const episodeEnd = new Map();
  const definitions = [
    ["BASELINE", "Прежний TP/SL"], ["TP1", "100% перед первой преградой"],
    ["PARTIAL", "50% TP1 + продолжение и отмена"], ["TRAIL", "50% TP1 + продолжение, отмена и трейлинг"],
  ];
  for (const record of [...records].sort((a, b) => a.asofTime - b.asofTime)) {
    for (const match of record.matches ?? []) {
      const study = match.windowStudy, trial = match.trial;
      if (!study || !trial) continue; // Never retrofit a map into old history.
      const key = `${match.id}:${study.version}`;
      let group = groups.get(key);
      if (!group) {
        group = { strategyId: match.id, label: match.label, version: study.version, observations: 0, duplicates: 0, overlapping: 0, episodes: 0,
          evaluated: 0, waiting: 0, pendingData: 0, unavailable: 0, incompleteMaps: 0, tightSpace: 0,
          directionCorrect: 0, firstTargetTouched: 0, firstTargetKnown: 0, fullWindowTouched: 0, cancellations: 0,
          variants: definitions.map(([id, label]) => ({ id, label, evaluated: 0, ambiguous: 0, wins: 0, losses: 0, flats: 0,
            netTotal: 0, grossTotal: 0, grossProfit: 0, grossLoss: 0, rTotal: 0, paired: 0, deltaTotal: 0,
            avoidedLosses: 0, missedWinners: 0, worsenedWinners: 0 })),
        };
        groups.set(key, group);
      }
      const signalKey = `${record.market}:${record.symbol}:${key}:${trial.signalTime}:${trial.side}`;
      if (seen.has(signalKey)) { group.duplicates++; continue; }
      seen.add(signalKey); group.observations++;
      if (study.missingTimeframes.length) group.incompleteMaps++;
      if (study.firstTarget == null) group.tightSpace++;
      const episodeKey = `${record.market}:${record.symbol}:${key}`;
      const starts = trial.availableAt ?? study.asOf;
      const overlaps = starts < (episodeEnd.get(episodeKey) ?? -Infinity);
      if (overlaps) group.overlapping++;
      else { group.episodes++; episodeEnd.set(episodeKey, trial.expiresAt); }
      const evaluation = study.evaluation;
      if (!evaluation || evaluation.status === "WAITING") { group.waiting++; continue; }
      if (evaluation.status === "PENDING_DATA") { group.pendingData++; continue; }
      if (evaluation.status === "UNAVAILABLE") { group.unavailable++; continue; }
      if (overlaps) continue;
      group.evaluated++;
      if (evaluation.directionCorrect) group.directionCorrect++;
      if (evaluation.firstTargetTouched != null) group.firstTargetKnown++;
      if (evaluation.firstTargetTouched) group.firstTargetTouched++;
      if (evaluation.fullWindowTouched) group.fullWindowTouched++;
      if (evaluation.cancelledAt != null) group.cancellations++;
      const baseline = evaluation.variants.find(v => v.id === "BASELINE");
      const riskPct = Math.abs(study.entryPrice - study.stopPrice) / study.entryPrice * 100;
      for (const result of evaluation.variants) {
        const aggregate = group.variants.find(v => v.id === result.id);
        if (!aggregate) continue;
        if (result.ambiguous) { aggregate.ambiguous++; continue; }
        aggregate.evaluated++;
        const net = result.netReturnPct;
        aggregate.netTotal += net; aggregate.grossTotal += result.grossReturnPct;
        aggregate.rTotal += riskPct > 0 ? net / riskPct : 0;
        if (net > 1e-9) { aggregate.wins++; aggregate.grossProfit += net; }
        else if (net < -1e-9) { aggregate.losses++; aggregate.grossLoss -= net; }
        else aggregate.flats++;
        if (baseline && !baseline.ambiguous) {
          aggregate.paired++; aggregate.deltaTotal += net - baseline.netReturnPct;
          if (baseline.netReturnPct < 0 && net >= 0) aggregate.avoidedLosses++;
          if (baseline.netReturnPct > 0 && net <= 0) aggregate.missedWinners++;
          if (baseline.netReturnPct > 0 && net < baseline.netReturnPct - 1e-9) aggregate.worsenedWinners++;
        }
      }
    }
  }
  return [...groups.values()].map(group => ({
    ...group,
    directionRatePct: group.evaluated ? group.directionCorrect / group.evaluated * 100 : null,
    firstTargetTouchRatePct: group.firstTargetKnown ? group.firstTargetTouched / group.firstTargetKnown * 100 : null,
    fullWindowTouchRatePct: group.evaluated ? group.fullWindowTouched / group.evaluated * 100 : null,
    variants: group.variants.map(v => ({ ...v, winRatePct: v.evaluated ? v.wins / v.evaluated * 100 : null,
      avgNetReturnPct: v.evaluated ? v.netTotal / v.evaluated : null,
      profitFactor: v.grossLoss > 0 ? v.grossProfit / v.grossLoss : null,
      expectancyR: v.evaluated ? v.rTotal / v.evaluated : null,
      avgDeltaVsBaselinePct: v.paired ? v.deltaTotal / v.paired : null,
      sampleSufficient: v.evaluated >= 30,
    })),
  }));
}
