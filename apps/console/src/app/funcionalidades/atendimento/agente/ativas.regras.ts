import {
  FERIADO, LIMITE_ATIVAS_MAX_DIA, LIMITE_ATIVAS_MAX_SEMANA, MAX_FERIADOS, normalizarFeriados,
} from '@geracrm/shared'

/**
 * Regras PURAS da tela de mensagens ativas (P11) — o que a tela mostra e
 * valida antes de mandar. A regra de negócio (quando a ativa sai) é da API;
 * aqui só apresentação e a mesma validação de borda do schema compartilhado.
 */

export interface FormAtivas {
  readonly limiteDia: number
  readonly limiteSemana: number
  readonly templateRetorno: string | null
  readonly feriados: readonly string[]
}

/** Erros por campo, na mesma chave do corpo da API. */
export type ErrosAtivas = Partial<Record<keyof FormAtivas | 'geral', string>>

export function validarAtivas(f: FormAtivas): ErrosAtivas {
  const e: ErrosAtivas = {}
  if (!Number.isInteger(f.limiteDia) || f.limiteDia < 1 || f.limiteDia > LIMITE_ATIVAS_MAX_DIA) {
    e.limiteDia = `Use um número inteiro de 1 a ${LIMITE_ATIVAS_MAX_DIA}.`
  }
  if (!Number.isInteger(f.limiteSemana) || f.limiteSemana < 1 || f.limiteSemana > LIMITE_ATIVAS_MAX_SEMANA) {
    e.limiteSemana = `Use um número inteiro de 1 a ${LIMITE_ATIVAS_MAX_SEMANA}.`
  } else if (!e.limiteDia && f.limiteSemana < f.limiteDia) {
    e.limiteSemana = 'O limite da semana não pode ser menor que o do dia.'
  }
  if (f.feriados.length > MAX_FERIADOS) e.feriados = `No máximo ${MAX_FERIADOS} feriados.`
  return e
}

/**
 * Data escolhida no seletor ("AAAA-MM-DD") → como o feriado é guardado:
 * só aquele dia, ou "MM-DD" quando vale todo ano. `null` = data inválida.
 */
export function feriadoDeData(dataIso: string, todoAno: boolean): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dataIso)) return null
  const f = todoAno ? dataIso.slice(5) : dataIso
  return FERIADO.test(f) ? f : null
}

/** Acrescenta sem repetir e mantém a ordem estável (a mesma da API). */
export function adicionarFeriado(lista: readonly string[], novo: string): string[] {
  return normalizarFeriados([...lista, novo])
}

export function removerFeriado(lista: readonly string[], f: string): string[] {
  return lista.filter((x) => x !== f)
}

/** "12-25" → "25/12 · todo ano"; "2026-11-20" → "20/11/2026". */
export function rotuloFeriado(f: string): string {
  const m = /^(?:(\d{4})-)?(\d{2})-(\d{2})$/.exec(f)
  if (!m) return f
  return m[1] ? `${m[3]}/${m[2]}/${m[1]}` : `${m[3]}/${m[2]} · todo ano`
}

/** O motivo gravado na suspensão, em português de quem opera. */
export function rotuloSuspensao(motivo: string): string {
  const [origem, evento, nota] = motivo.split(':')
  if (origem === 'conta') {
    return `A Meta restringiu a conta (${evento ?? 'restrição'}). Confira o Gerenciador do WhatsApp antes de liberar.`
  }
  const porEvento: Record<string, string> = {
    FLAGGED: 'qualidade do número caiu para baixa',
    DOWNGRADE: 'a Meta reduziu o limite de envio do número',
  }
  const causa = nota === 'RED' ? 'qualidade do número em vermelho' : porEvento[evento ?? ''] ?? `evento ${evento ?? 'da Meta'}`
  return `Suspensas porque a ${causa}. Voltam sozinhas quando a Meta normalizar.`
}

/** Status de template da Meta → rótulo e tom do badge. */
export function badgeStatusTemplate(status: string): { rotulo: string; tom: 'sucesso' | 'atencao' | 'erro' | 'neutro' } {
  switch (status) {
    case 'APPROVED': return { rotulo: 'Aprovado', tom: 'sucesso' }
    case 'PENDING': return { rotulo: 'Em análise na Meta', tom: 'atencao' }
    case 'PAUSED': return { rotulo: 'Pausado pela Meta', tom: 'erro' }
    case 'REJECTED': return { rotulo: 'Rejeitado', tom: 'erro' }
    case 'DISABLED': return { rotulo: 'Desativado', tom: 'erro' }
    default: return { rotulo: status, tom: 'neutro' }
  }
}

/** Erro tipificado da API → mensagem e campo. */
export function erroDaApi(codigo: string | undefined, mensagem: string | undefined, campos: readonly string[] | undefined): ErrosAtivas {
  const texto = mensagem?.trim() || 'Não foi possível salvar.'
  const campo = campos?.[0]
  if (campo === 'limiteDia' || campo === 'limiteSemana' || campo === 'feriados' || campo === 'templateRetorno') {
    return { [campo]: texto }
  }
  if (codigo === 'acesso.papel_insuficiente') return { geral: 'Só um administrador pode mudar as mensagens ativas.' }
  return { geral: texto }
}
