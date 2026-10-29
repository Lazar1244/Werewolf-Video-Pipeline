import type { AnyDecision, DecisionOf, DecisionRequest } from '@ww/shared';

/** Legality of a (schema-valid) decision against its request's legal options. Returns issues. */
export function checkLegal(req: DecisionRequest, d: AnyDecision): string[] {
  const L = req.legal;
  const inTargets = (x: number) => (L.targets ?? []).includes(x);
  switch (req.kind) {
    case 'sheriff_run':
    case 'message':
      return [];
    case 'speech': {
      const s = d as DecisionOf<'speech'>;
      if (s.lean != null && !(L.leanTargets ?? []).includes(s.lean)) return [`lean must be one of ${fmt(L.leanTargets)} or null`];
      return [];
    }
    case 'vote': {
      const v = d as DecisionOf<'vote'>;
      const issues: string[] = [];
      if (v.second_vote && !L.secondVote) issues.push('second_vote is not available to you');
      if (v.vote === 'abstain') {
        if (L.allowNone === false) issues.push('abstaining is not allowed');
      } else if (!inTargets(v.vote)) issues.push(`vote must be one of ${fmt(L.targets)} or "abstain"`);
      return issues;
    }
    case 'council_turn': {
      const c = d as DecisionOf<'council_turn'>;
      if (c.proposed_target !== null && !inTargets(c.proposed_target)) return [`proposed_target must be one of ${fmt(L.targets)} or null`];
      return [];
    }
    case 'council_ballot': {
      const c = d as DecisionOf<'council_ballot'>;
      if (c.target === null) return L.allowNone ? [] : ['a target is required'];
      return inTargets(c.target) ? [] : [`target must be one of ${fmt(L.targets)}`];
    }
    case 'target': {
      const t = d as DecisionOf<'target'>;
      if (t.target === null) return L.allowNone ? [] : ['a target is required'];
      return inTargets(t.target) ? [] : [`target must be one of ${fmt(L.targets)}${L.allowNone ? ' or null' : ''}`];
    }
    case 'witch': {
      const w = d as DecisionOf<'witch'>;
      const issues: string[] = [];
      if (w.heal && !L.canHeal) issues.push('you cannot heal tonight');
      if (w.poison !== null && !(L.poisonTargets ?? []).includes(w.poison)) issues.push(`poison must be one of ${fmt(L.poisonTargets)} or null`);
      if (w.heal && w.poison !== null && w.poison === L.healTarget) issues.push('you cannot heal and poison the same player');
      return issues;
    }
    case 'choice': {
      const c = d as DecisionOf<'choice'>;
      return (L.choices ?? []).includes(c.choice) ? [] : [`choice must be one of [${(L.choices ?? []).join(', ')}]`];
    }
    case 'pair': {
      const p = d as DecisionOf<'pair'>;
      if (p.targets[0] === p.targets[1]) return ['the two players must be different'];
      return p.targets.every(inTargets) ? [] : [`both players must be in ${fmt(L.targets)}`];
    }
    case 'multi': {
      const m = d as DecisionOf<'multi'>;
      const issues: string[] = [];
      if (new Set(m.targets).size !== m.targets.length) issues.push('players must be distinct');
      if (!m.targets.every(inTargets)) issues.push(`players must be in ${fmt(L.targets)}`);
      if (m.targets.length < (L.min ?? 0) || m.targets.length > (L.max ?? 10)) issues.push(`choose between ${L.min ?? 0} and ${L.max ?? 10} players`);
      return issues;
    }
  }
}

const fmt = (xs: readonly number[] | undefined) => `[${(xs ?? []).join(', ')}]`;
