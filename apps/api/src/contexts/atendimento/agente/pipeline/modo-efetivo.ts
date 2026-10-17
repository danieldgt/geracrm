import {
  decidirModoEfetivo, ehModoAgente, maisRestritivo, normalizarFeriados, recorteAgente,
  type DecisaoModo, type ModoAgente, type MomentoLocal,
} from '@geracrm/shared'
import { comTenantServico, type Sql } from '../../../../db/index.js'
import { momentoNoFuso } from '../../../plataforma/fuso.js'
import { ehFeriado } from '../../expediente.js'
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
 * ⚠️ TODO caminho que age em nome do agente (turno, ausência que cede a vez ao
 *    agente, "digitando…", retorno/cadência, copiloto) pergunta o modo por
 *    `modoEfetivoDoCanal` — nunca por `agente_config.modo` direto. Ler a coluna
 *    é o jeito de o kill switch do tenant não alcançar o caminho.
 *
 * ⚠️ O motivo volta como marca `modo-efetivo` (INFO, registrado) em TODA
 *    decisão do turno (vendedor.ts): "por que ele não respondeu às 20h?" tem
 *    resposta no banco.
 */

export interface FatosDoModo {
  readonly modoTenant: ModoAgente | null
  readonly momento: MomentoLocal
}

/**
 * Teto do tenant e momento local, na transação de quem chama. A hora local sai
 * em TS (`momentoNoFuso`): fuso inválido no banco cai no padrão, não derruba.
 */
export async function lerFatosDoModo(tx: Sql, agora: Date, canalId?: string | null): Promise<FatosDoModo> {
  const [l] = await tx<{ modo_maximo: string | null; fuso: string | null; feriados: unknown }[]>`
    SELECT (SELECT modo_maximo FROM agente_tenant WHERE tenant_id = tenant_atual()) AS modo_maximo,
           (SELECT fuso FROM tenant WHERE id = tenant_atual()) AS fuso,
           ${canalId
             ? tx`(SELECT feriados FROM canal_configuracao WHERE tenant_id = tenant_atual() AND canal_id = ${canalId})`
             : tx`NULL::jsonb`} AS feriados`
  const teto = l?.modo_maximo
  const { data, ...momento } = momentoNoFuso(agora, l?.fuso)
  // ⚠️ FERIADO do número (P11, `canal_configuracao.feriados`, mesma régua da
  //    ausência e das ativas — `ehFeriado`) conta como FORA do horário do recorte.
  const feriado = ehFeriado(normalizarFeriados(l?.feriados), data)
  return { modoTenant: ehModoAgente(teto) ? teto : null, momento: { ...momento, feriado } }
}

/** O recorte usa segmento? Só então vale a consulta às métricas do contato. */
function recorteUsaSegmento(recorte: unknown): boolean {
  const p = recorteAgente.safeParse(recorte)
  return p.success && p.data.segmentosRfv.length > 0
}

/** Os fatos + a decisão, para um contato (turno) — o número já lido por quem chama. */
export async function modoEfetivoDoContato(
  tx: Sql, p: { modoDoNumero: ModoAgente; recorte: unknown; canalId: string; contatoId: string | null | undefined; agora: Date },
): Promise<DecisaoModo> {
  const fatos = await lerFatosDoModo(tx, p.agora, p.canalId)
  const segmento = p.contatoId && recorteUsaSegmento(p.recorte) ? await segmentoRfvDoContato(tx, p.contatoId) : undefined
  return decidirModoEfetivo({ modoTenant: fatos.modoTenant, modoNumero: p.modoDoNumero, recorte: p.recorte ?? null, momento: fatos.momento, segmento })
}

export interface ModoEfetivoDoCanal extends DecisaoModo {
  /** `agente_config.modo` do número (`desligado` quando o número não tem configuração). */
  readonly modoDoNumero: ModoAgente
}

/**
 * O MODO EFETIVO de um número agora — a função ÚNICA para quem age em nome do
 * agente fora do turno (ausência, "digitando…", retorno, copiloto).
 *
 *   modoEfetivoDoCanal(tx, { canalId, contatoId?, agora }) → { modo, origem, motivo, foraDoRecorte, recorteInvalido, modoDoNumero }
 *
 * - `tx` sob RLS do tenant (`comTenantServico` / `req.comTenant`).
 * - Número sem `agente_config` → `desligado`.
 * - `contatoId` ausente: a parte de SEGMENTO do recorte não é avaliada (horário
 *   e teto do tenant sim). Quem tem o contato, passa.
 * - Lança só se o banco falhar; quem não pode quebrar usa `modoEfetivoSeguro`.
 */
export async function modoEfetivoDoCanal(
  tx: Sql, p: { canalId: string; contatoId?: string | null | undefined; agora: Date },
): Promise<ModoEfetivoDoCanal> {
  const [cfg] = await tx<{ modo: string; recorte: unknown }[]>`
    SELECT modo, recorte FROM agente_config WHERE tenant_id = tenant_atual() AND canal_id = ${p.canalId}`
  const modoDoNumero: ModoAgente = cfg && ehModoAgente(cfg.modo) ? cfg.modo : 'desligado'
  if (modoDoNumero === 'desligado') {
    return { modo: 'desligado', origem: 'numero', motivo: null, foraDoRecorte: [], recorteInvalido: false, modoDoNumero }
  }
  const d = await modoEfetivoDoContato(tx, { modoDoNumero, recorte: cfg?.recorte ?? null, canalId: p.canalId, contatoId: p.contatoId, agora: p.agora })
  return { ...d, modoDoNumero }
}

/** Código da marca quando os fatos do modo não puderam ser lidos (falha FECHADA). */
export const MOTIVO_MODO_INDISPONIVEL = 'modo_efetivo_indisponivel'

/**
 * `modoEfetivoDoCanal` em transação própria e FALHA FECHADA: se a leitura
 * quebrar, o modo é `sombra` (ou mais restritivo) — nunca "segue autônomo
 * porque não deu para checar o kill switch".
 */
export async function modoEfetivoSeguro(
  tenantId: string, p: { canalId: string; contatoId?: string | null | undefined; agora: Date },
): Promise<{ modo: ModoAgente; motivo: string | null }> {
  try {
    const d = await comTenantServico(tenantId, (tx) => modoEfetivoDoCanal(tx, p))
    return { modo: d.modo, motivo: d.motivo }
  } catch {
    return { modo: 'sombra', motivo: MOTIVO_MODO_INDISPONIVEL }
  }
}

export const etapaModoEfetivo: EtapaModoEfetivo = {
  nome: 'modo-efetivo',
  async decidir(entrada) {
    // Desligado no número já é o mais restritivo: nada a consultar.
    if (entrada.modoDoNumero === 'desligado') return { modo: 'desligado', motivo: null }
    try {
      const d = await comTenantServico(entrada.tenantId, (tx) => modoEfetivoDoContato(tx, {
        modoDoNumero: entrada.modoDoNumero, recorte: entrada.cfgExtra['recorte'] ?? null,
        canalId: entrada.canalId, contatoId: entrada.contatoId, agora: entrada.agora,
      }))
      return { modo: d.modo, motivo: d.motivo }
    } catch {
      // ⚠️ FALHA FECHADA: sem conseguir ler o teto/recorte, o agente não fala
      //    sozinho — cai para sombra (ou fica no do número, se já for menor).
      const modo = maisRestritivo(entrada.modoDoNumero, 'sombra')
      return { modo, motivo: MOTIVO_MODO_INDISPONIVEL }
    }
  },
}
