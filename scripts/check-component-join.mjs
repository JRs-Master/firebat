#!/usr/bin/env node
/**
 * The component registry and the page renderer are joined by name strings, by hand.
 *
 * `components.json` is what the AI discovers and validates against; the ComponentSwitch in
 * `app/(user)/[...slug]/components.tsx` is what actually draws. Nothing enforced the join: a
 * registry `componentType` with no switch case renders as silence (the `header` vs `Header`
 * incident — one letter of case, and fenced output fell through to plain text), and the count
 * test only counts. This walks the join both ways.
 *
 * Registry type without a renderer case = hard failure — the AI can emit it and nobody draws it.
 * Renderer case without a registry entry = fine — internal components (ResultDisplay) are drawn
 * by the system, not discovered by models.
 */
import { readFileSync } from 'node:fs';

const registry = JSON.parse(
  readFileSync('system/components.json', 'utf-8'),
);
const comps = Array.isArray(registry) ? registry : registry.components;
const wanted = new Map(comps.map(c => [c.componentType, c.name]));

const fe = readFileSync('app/(user)/[...slug]/components.tsx', 'utf-8');
const cases = new Set([...fe.matchAll(/case '(\w+)':/g)].map(m => m[1]));
// TYPE_ALIAS maps registry spellings onto case labels; both ends of the alias count as covered.
const aliasBlock = fe.slice(fe.indexOf('TYPE_ALIAS'), fe.indexOf('TYPE_ALIAS') + 4000);
for (const [, from, to] of aliasBlock.matchAll(/(\w+):\s*'(\w+)'/g)) {
  if (cases.has(to)) cases.add(from);
}

const missing = [...wanted].filter(([type]) => !cases.has(type));
if (missing.length) {
  for (const [type, name] of missing) {
    console.error(`::error file=system/components.json::component '${name}' declares componentType '${type}' but the page renderer has no case for it — it will render as nothing`);
  }
  process.exit(1);
}
console.log(`component join ok — ${wanted.size} registry types all reachable by the renderer`);
