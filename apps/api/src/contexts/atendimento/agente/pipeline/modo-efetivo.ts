import {
  decidirModoEfetivo, ehModoAgente, recorteAgente, type DecisaoModo, type ModoAgente, type MomentoLocal,
} from '@geracrm/shared'
import { comTenantServico, type Sql } from '../../../../db/index.js'
import { segmentoRfvDoContato } from '../contexto-lead.js'
import type { EtapaModoEfetivo } from './tipos.js'

/**
 * MODO EFETIVO (raia P14, ADR-028: "o mais restritivo vence").
 *
 * Roda ANTES do portão: um número em autônomo fora do recorte entra no portão
 * como o modo de `foraDoRecorte` (padrão sombra) e o teto do tenant
 * (`agente_tenant.modo_maximo`) vale para todos os números. A decisão é a
 * função pura `decidirModoEfetivo` (shared); aqui só se COLETAM os fatos:
 * teto do tenant, momento local no fuso do tenant e — só quando o recorte usa
 * segmento — o segmento RFV do contato.
 *
 * ⚠️ O motivo volta como marca `modo-efetivo` (INFO, registrado) em TODA
 *    decisão do turno (vendedor.ts): "por que ele não respondeu às 20h?" tem
 *    resposta no banco.
 */

export interface FatosDoModo {
  readonly modoTenant: ModoAgente | null
  readonly momento: MomentoLocal
}

/** Teto do tenant e momento local (fuso do tenant), na transação de quem chama. */
export async function lerFatosDoModo(tx: Sql, agora: Date): Promise<FatosDoModo> {
  const [l] = await tx<{ modo_maximo: string | null; dia_iso: number; hora: string }[]>`
    SELECT (SELECT modo_maximo FROM agente_tenant WHERE tenant_id = tenant_atual()) AS modo_maximo,
           to_char(${agora}::timestamptz AT TIME ZONE f.fuso, 'ID')::int AS dia_iso,
           to_char(${agora}::timestamptz AT TIME ZONE f.fuso, 'HH24:MI') AS hora
      FROM (SELECT coalesce((SELECT fuso FROM tenant WHERE id = tenant_atual()), 'America/Sao_Paulo') AS fuso) f`
  const teto = l?.modo_maximo
  return {
    modoTenant: ehModoAgente(teto) ? teto : null,
    momento: { diaIso: l?.dia_iso ?? 1, hora: l?.hora ?? '12:00' },
  }
}

/** O recorte usa segmento? Só então vale a consulta às métricas do contato. */
function recorteUsaSegmento(recorte: unknown): boolean {
  const p = recorteAgente.safeParse(recorte)
  return p.success && p.data.segmentosRfv.length > 0
}

/** Os fatos + a decisão, para um contato (turno) — exportado para a rota e os testes. */
export async function modoEfetivoDoContato(
  tx: Sql, p: { modoDoNumero: ModoAgente; recorte: unknown; contatoId: string; agora: Date },
): Promise<DecisaoModo> {
  const fatos = await lerFatosDoModo(tx, p.agora)
  const segmento = recorteUsaSegmento(p.recorte) ? await segmentoRfvDoContato(tx, p.contatoId) : undefined
  return decidirModoEfetivo({ modoTenant: fatos.modoTenant, modoNumero: p.modoDoNumero, recorte: p.recorte ?? null, momento: fatos.momento, segmento })
}

export const etapaModoEfetivo: EtapaModoEfetivo = {
  nome: 'modo-efetivo',
  async decidir(entrada) {
    // Desligado no número já é o mais restritivo: nada a consultar.
    if (entrada.modoDoNumero === 'desligado') return { modo: 'desligado', motivo: null }
    const d = await comTenantServico(entrada.tenantId, (tx) => modoEfetivoDoContato(tx, {
      modoDoNumero: entrada.modoDoNumero, recorte: entrada.cfgExtra['recorte'] ?? null,
      contatoId: entrada.contatoId, agora: entrada.agora,
    }))
    return { modo: d.modo, motivo: d.motivo }
  },
}
