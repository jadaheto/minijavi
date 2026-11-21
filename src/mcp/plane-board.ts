import { PlaneMcpService } from './plane-mcp.service';

/**
 * Tablero de tareas de Plane para la pantalla (pedido por Javier el 2026-11-20). Solo lectura: usa `list_projects`,
 * `list_states`, `list_work_items` y `get_me` del MCP de Plane, que ya estan en la lista de solo consulta.
 * Forma de las respuestas vista el 2026-11-20 (con el MCP de Plane de Javier):
 *  - list_projects -> {total_count, next_cursor, results: [{id, name, identifier, description, archived_at?}]}
 *  - list_states   -> {results: [{id, name, group: backlog|unstarted|started|completed|cancelled, color}]}
 *  - list_work_items -> {total_count, next_cursor, results: [{id, sequence_id, name, state, priority, assignees[],
 *    target_date, updated_at, completed_at}]}
 * No se confirmo que el MCP de produccion (PLANE_MCP_URL) responda con esa misma forma, ni la de `get_me`: si algo no
 * cuadra, el tablero dice que no pudo leerlo. Los nombres de proyectos y tareas son texto de terceros.
 */
export interface BoardCard { key: string; name: string; priority: string; due?: string; late?: boolean; today?: boolean; }
export interface BoardColumn { group: string; name: string; color: string; count: number; cards: BoardCard[]; }
export interface Board { project: string; identifier: string; mine: boolean; total: number; open: number; done: number; late: number; dueToday: number; columns: BoardColumn[]; truncated: boolean; }
export type BoardOutcome = { board: Board } | { choose: { name: string; identifier: string }[] } | { error: string };

const GROUPS = ['unstarted', 'started', 'completed', 'backlog'] as const; // orden en pantalla; las canceladas no se muestran
const LABEL: Record<string, string> = { backlog: 'Pendientes', unstarted: 'Por hacer', started: 'En curso', completed: 'Hechas' };
const PRIORITY: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
const clean = (s: unknown, max: number) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const plainKey = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

export async function buildBoard(plane: PlaneMcpService, projectName: string, mineOnly: boolean, today: string): Promise<BoardOutcome> {
  try {
    const projects = ((await plane.read('list_projects', { per_page: 100 }))?.results ?? []).filter((p: any) => p?.id && !p.archived_at);
    if (!projects.length) return { error: 'Plane no devolvió proyectos' };
    // Se acepta el nombre, el identificador, el codigo (UUID) del proyecto o su direccion en Plane (que trae ese codigo).
    const uuid = projectName.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0].toLowerCase();
    const want = uuid ? '' : plainKey(projectName);
    const exact = projects.filter((p: any) => (uuid ? String(p.id).toLowerCase() === uuid : plainKey(String(p.name)) === want || plainKey(String(p.identifier)) === want));
    if (uuid && !exact.length) return { error: 'ese proyecto no está entre los que la clave de Plane puede ver (o está archivado)' };
    const words = want.split(' ').filter(Boolean);
    const hits = exact.length ? exact : !want ? [] : projects.filter((p: any) => words.every((w) => plainKey(`${p.name} ${p.identifier}`).includes(w)));
    if (hits.length !== 1 && projects.length > 1) return { choose: (hits.length ? hits : projects).slice(0, 30).map((p: any) => ({ name: clean(p.name, 60), identifier: clean(p.identifier, 20) })) };
    const project = hits[0] ?? projects[0];

    const [states, me] = await Promise.all([plane.read('list_states', { project_id: project.id }), mineOnly ? plane.read('get_me', {}).catch(() => null) : null]);
    const stateOf = new Map<string, { name: string; group: string; color: string }>();
    for (const s of states?.results ?? []) if (s?.id) stateOf.set(String(s.id), { name: clean(s.name, 30), group: String(s.group), color: /^#[0-9a-f]{6}$/i.test(String(s.color)) ? String(s.color) : '#6fb2ff' });
    if (!stateOf.size) return { error: 'Plane no devolvió los estados del proyecto' };
    const myId = String(me?.id ?? me?.user?.id ?? '');
    if (mineOnly && !myId) mineOnly = false; // no se supo quien es Javier en Plane: se muestran todas y se dice

    const items: any[] = []; let cursor: string | undefined, truncated = false;
    for (let page = 0; page < 4; page++) { // hasta 400 tareas, las de cambio mas reciente primero
      const out = await plane.read('list_work_items', { project_id: project.id, per_page: 100, order_by: '-updated_at', ...(cursor ? { cursor } : {}) });
      items.push(...(out?.results ?? []));
      cursor = out?.next_cursor && (out?.results?.length ?? 0) === 100 ? String(out.next_cursor) : undefined;
      if (!cursor) break;
      if (page === 3) truncated = true;
    }
    const mine = items.filter((i) => !mineOnly || (Array.isArray(i?.assignees) && i.assignees.map(String).includes(myId)));
    const columns: BoardColumn[] = [];
    let late = 0, dueToday = 0;
    for (const group of GROUPS) {
      const inGroup = mine.filter((i) => stateOf.get(String(i.state))?.group === group);
      const st = [...stateOf.values()].find((s) => s.group === group);
      if (!st && !inGroup.length) continue;
      const cards: BoardCard[] = inGroup.map((i) => {
        const due = /^\d{4}-\d{2}-\d{2}$/.test(String(i.target_date)) ? String(i.target_date) : undefined, open = group !== 'completed';
        const isLate = !!due && open && due < today, isToday = !!due && open && due === today;
        if (isLate) late++; if (isToday) dueToday++;
        return { key: `${clean(project.identifier, 12)}-${Number(i.sequence_id) || '?'}`, name: clean(i.name, 110), priority: PRIORITY[String(i.priority)] !== undefined ? String(i.priority) : 'none', due, late: isLate || undefined, today: isToday || undefined };
      });
      // Abiertas: primero lo atrasado y lo de hoy, luego por prioridad y fecha. Hechas: se quedan en orden de cambio reciente.
      if (group !== 'completed') cards.sort((a, b) => Number(!!b.late) - Number(!!a.late) || Number(!!b.today) - Number(!!a.today) || PRIORITY[a.priority] - PRIORITY[b.priority] || (a.due ?? '9').localeCompare(b.due ?? '9'));
      columns.push({ group, name: LABEL[group], color: st?.color ?? '#6fb2ff', count: cards.length, cards: cards.slice(0, 6) });
    }
    const count = (g: string) => columns.find((c) => c.group === g)?.count ?? 0, done = count('completed'), open = count('unstarted') + count('started') + count('backlog');
    return { board: { project: clean(project.name, 60), identifier: clean(project.identifier, 20), mine: mineOnly, total: open + done, open, done, late, dueToday, columns, truncated } };
  } catch (e) { return { error: (e as Error).message }; }
}
