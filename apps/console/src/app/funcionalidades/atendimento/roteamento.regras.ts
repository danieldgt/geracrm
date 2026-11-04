/**
 * Regras puras da seção Roteamento (raia G4) — sem DOM, testáveis.
 * A validação é a MESMA de `@geracrm/shared` (a API é a regra; aqui é conveniência).
 */
import {
  LIMITES_ROTEAMENTO, ROTULO_MOTIVO_FILIAL, ROTULO_TIPO_REGRA, TIPOS_REGRA_ROTEAMENTO, validarValorDaRegra,
  type CorpoRegraRoteamento, type RegraRoteamento, type SimulacaoRoteamento, type TipoRegraRoteamento,
} from '@geracrm/shared'

export { ROTULO_TIPO_REGRA, TIPOS_REGRA_ROTEAMENTO, type RegraRoteamento, type TipoRegraRoteamento }

export type CampoRegra = 'tipo' | 'valor' | 'filialId' | 'canalId' | 'prioridade'
export interface ErroRoteamento { readonly campo: CampoRegra | null; readonly mensagem: string }

const ERROS: Record<string, ErroRoteamento> = {
  'roteamento.valor_invalido': { campo: 'valor', mensagem: 'Valor inválido para o tipo.' },
  'roteamento.origem_invalida': { campo: 'valor', mensagem: 'Origem não encontrada.' },
  'roteamento.filial_invalida': { campo: 'filialId', mensagem: 'Filial não encontrada.' },
  'roteamento.filial_inativa': { campo: 'filialId', mensagem: 'Esta filial está desativada.' },
  'roteamento.numero_invalido': { campo: 'canalId', mensagem: 'Número não encontrado.' },
  'roteamento.regra_duplicada': { campo: 'valor', mensagem: 'Já existe uma regra igual (mesmo tipo, valor e número).' },
  'roteamento.regra_nao_encontrada': { campo: null, mensagem: 'A regra não existe mais. Recarregue a lista.' },
  'roteamento.nada_a_mudar': { campo: null, mensagem: 'Nada foi alterado.' },
}

/** Código da API → campo e mensagem. A mensagem da API (quando vem) é mais precisa que a genérica. */
export function mapearErroRoteamento(codigo: string | null, mensagemApi?: string | null): ErroRoteamento | null {
  const e = codigo ? ERROS[codigo] : undefined
  if (!e) return null
  return { campo: e.campo, mensagem: mensagemApi?.trim() || e.mensagem }
}

/** O que a coluna "Valor" mostra: "85", o nome da origem, ou "—" no padrão. */
export function rotuloValor(r: Pick<RegraRoteamento, 'tipo' | 'valor' | 'valorRotulo'>): string {
  if (r.tipo === 'padrao') return '—'
  if (r.tipo === 'origem') return r.valorRotulo ?? '(origem removida)'
  return r.valor ?? '—'
}

export const rotuloNumero = (r: Pick<RegraRoteamento, 'canalId' | 'canalNome'>): string =>
  r.canalId ? (r.canalNome ?? 'Número removido') : 'Todos os números'

export interface FormRegra {
  readonly tipo: string
  /** DDD digitado (tipo ddd). */
  readonly ddd: string
  /** Origem escolhida (tipo origem). */
  readonly origemId: string
  readonly filialId: string
  /** '' = todos os números. */
  readonly canalId: string
  readonly prioridade: string
  readonly ativa: boolean
}

export const FORM_REGRA_VAZIO: FormRegra = {
  tipo: 'ddd', ddd: '', origemId: '', filialId: '', canalId: '', prioridade: String(LIMITES_ROTEAMENTO.prioridadePadrao), ativa: true,
}

export function ehTipoRegra(v: string): v is TipoRegraRoteamento {
  return (TIPOS_REGRA_ROTEAMENTO as readonly string[]).includes(v)
}

/** Erros por campo antes de enviar (a mesma régua do shared). Vazio = pode enviar. */
export function validarFormRegra(f: FormRegra): Partial<Record<CampoRegra, string>> {
  const erros: Partial<Record<CampoRegra, string>> = {}
  if (!ehTipoRegra(f.tipo)) erros.tipo = 'Escolha o tipo.'
  else {
    const v = validarValorDaRegra(f.tipo, valorDoForm(f))
    if (!v.ok) erros.valor = v.mensagem
  }
  if (!f.filialId) erros.filialId = 'Escolha a filial.'
  const p = Number(f.prioridade)
  if (!/^\d+$/.test(f.prioridade.trim()) || p < LIMITES_ROTEAMENTO.prioridadeMin || p > LIMITES_ROTEAMENTO.prioridadeMax) {
    erros.prioridade = `Prioridade de ${LIMITES_ROTEAMENTO.prioridadeMin} a ${LIMITES_ROTEAMENTO.prioridadeMax}.`
  }
  return erros
}

function valorDoForm(f: FormRegra): string | null {
  if (f.tipo === 'ddd') return f.ddd.replace(/\D/g, '') || null
  if (f.tipo === 'origem') return f.origemId || null
  return null
}

/** Corpo do POST/PATCH (o PATCH manda o objeto inteiro: a API mescla e confere). */
export function montarPayloadRegra(f: FormRegra): CorpoRegraRoteamento {
  return {
    tipo: ehTipoRegra(f.tipo) ? f.tipo : 'ddd',
    valor: valorDoForm(f),
    filialId: f.filialId,
    canalId: f.canalId || null,
    prioridade: Number(f.prioridade),
    ativa: f.ativa,
  }
}

/** Regra gravada → formulário de edição. */
export function formDaRegra(r: RegraRoteamento): FormRegra {
  return {
    tipo: r.tipo,
    ddd: r.tipo === 'ddd' ? (r.valor ?? '') : '',
    origemId: r.tipo === 'origem' ? (r.valor ?? '') : '',
    filialId: r.filialId,
    canalId: r.canalId ?? '',
    prioridade: String(r.prioridade),
    ativa: r.ativa,
  }
}

/** As frases do resultado do simulador — o MESMO vocabulário que a API usou para decidir. */
export function descreverSimulacao(s: SimulacaoRoteamento): { filial: string; vendedor: string; aviso: string | null } {
  const filial = s.filial
    ? `${s.filial.nome} — ${ROTULO_MOTIVO_FILIAL[s.motivo]}${s.motivo === 'ddd' && s.ddd ? ` (${s.ddd})` : ''}`
    : `Nenhuma filial — ${ROTULO_MOTIVO_FILIAL.nenhuma}`
  const vendedor = s.vendedor
    ? `${s.vendedor.nome} (a vez de ${s.elegiveis === 1 ? '1 vendedor' : `${s.elegiveis} vendedores`} no rodízio)`
    : s.filial ? 'Ninguém disponível nesta filial para este número' : '—'
  const aviso = s.rodizioNaEntrada === false
    ? 'O rodízio na entrada está DESLIGADO neste número: o contato novo nasce sem dono.'
    : null
  return { filial, vendedor, aviso }
}
