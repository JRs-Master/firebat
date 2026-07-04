/**
 * Skill .md ⟷ fields conversion for the Monaco editor — mirrors the Rust
 * skill_file.rs `serialize_entry` / `parse_entry` exactly, so what the editor
 * shows/saves round-trips byte-identically with what the backend stores.
 * (The skill APIs speak {name, kind, description, content}; Monaco edits one
 * .md document with YAML frontmatter.)
 */

export interface SkillFields {
  name: string;
  kind: string;
  description: string;
  content: string;
}

/** fields → one .md document (frontmatter + body). = Rust serialize_entry. */
export function skillToMd(f: Partial<SkillFields> & { slug?: string }): string {
  const kind = (f.kind ?? '').trim() || 'procedure';
  const name = (f.name ?? '').trim() || (f.slug ?? '');
  const description = (f.description ?? '').trim();
  return `---\nname: ${name}\nkind: ${kind}\ndescription: ${description}\n---\n${f.content ?? ''}`;
}

/** .md document → fields. = Rust parse_entry (frontmatter optional → whole doc = content). */
export function parseSkillMd(raw: string, slugFallback = ''): SkillFields {
  let name = slugFallback;
  let kind = 'procedure';
  let description = '';
  let content = raw;
  if (raw.startsWith('---\n')) {
    const body = raw.slice(4);
    const idx = body.indexOf('\n---\n');
    if (idx >= 0) {
      const fm = body.slice(0, idx);
      content = body.slice(idx + 5);
      for (const line of fm.split('\n')) {
        const colon = line.indexOf(':');
        if (colon < 0) continue;
        const k = line.slice(0, colon).trim();
        const v = line.slice(colon + 1).trim();
        if (k === 'name' && v) name = v;
        else if (k === 'kind' && v) kind = v;
        else if (k === 'description') description = v;
      }
    }
  }
  return { name, kind, description, content };
}
