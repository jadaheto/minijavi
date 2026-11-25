import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';

/**
 * Lo que opina Javier de cada calificacion (etapa 3a, entrega 3). En el panel puede marcar el puntaje de un interesado
 * como «está bien» o «no coincide». Se guarda el puntaje y el nivel que tenia en ese momento: con eso despues se puede
 * medir cuanto acierta la tabla y ajustarla. Regla de la hoja de ruta: la medicion de aciertos solo se informa con 30
 * marcas o mas; con menos se dice cuantas van, sin porcentaje.
 *
 * Va aparte de `ScoringService` a proposito: la calificacion solo LEE; esto es lo unico que escribe, y escribe solo en
 * su propia tabla. Una marca no cambia el puntaje ni el estado de nadie.
 */
export const MARKS = ['bien', 'mal'] as const;
export type Mark = (typeof MARKS)[number];
export const MIN_MARKS = 30;

@Injectable()
export class ScoreMarksService {
  constructor(private readonly db: DbService) {}

  /** Marca (o desmarca, con '') la calificacion actual de un interesado. Devuelve false si no hay nada que marcar. */
  async set(leadId: number, mark: string, rating: { score: number | null; level: string } | undefined): Promise<boolean> {
    const id = Math.floor(Number(leadId)) || 0; if (id <= 0) return false;
    await this.db.query('DELETE FROM lead_marks WHERE lead_id = $1', [id]);
    if (!mark) return true;
    if (!(MARKS as readonly string[]).includes(mark) || !rating || rating.score === null) return false;
    await this.db.query('INSERT INTO lead_marks (lead_id, at, score, level, mark) VALUES ($1, $2, $3, $4, $5)', [id, new Date().toISOString(), Math.round(rating.score), String(rating.level).slice(0, 20), mark]);
    return true;
  }

  async all(): Promise<Map<number, { mark: Mark; score: number; level: string; at: string }>> {
    const rows = await this.db.query<{ lead_id: number; mark: Mark; score: number; level: string; at: string }>('SELECT lead_id, mark, score, level, at FROM lead_marks').catch(() => []);
    return new Map(rows.map((r) => [Number(r.lead_id), { mark: r.mark, score: Number(r.score), level: r.level, at: String(r.at) }]));
  }

  /** Cuantas marcas hay y cuantas dicen que el puntaje estaba bien. `enough`: ya son suficientes para hablar de un porcentaje. */
  async accuracy(): Promise<{ marked: number; ok: number; enough: boolean; needed: number }> {
    const all = [...(await this.all()).values()], ok = all.filter((m) => m.mark === 'bien').length;
    return { marked: all.length, ok, enough: all.length >= MIN_MARKS, needed: MIN_MARKS };
  }
}
