/**
 * As seções da tela do agente: 5 GRUPOS pela tarefa (configurar, ensinar,
 * testar, acompanhar, medir a qualidade), cada um com as suas sub-seções.
 *
 * ⚠️ As sub-seções das raias do plano-port-playbook-am entram pela constante
 * `ABA_*_PRONTA` do PRÓPRIO componente (passada em `prontas`): a raia liga a sua
 * sub-seção sem editar esta lista. Grupo sem nenhuma sub-seção pronta some.
 *
 * Funções puras — o endereço (`?aba=<grupo>&sub=<sub>`) é decidido aqui e
 * testado sem Angular.
 */

export type SubAgente = 'configuracao' | 'protecoes' | 'conhecimento' | 'playbook' | 'playground'
  | 'sessoes' | 'decisoes' | 'qualidade' | 'revisao' | 'metricas'
export type GrupoAgente = 'configurar' | 'ensinar' | 'testar' | 'acompanhar' | 'medir'

export interface SubDef { readonly id: SubAgente; readonly rotulo: string }
export interface GrupoDef { readonly id: GrupoAgente; readonly rotulo: string; readonly subs: readonly SubDef[] }

export const GRUPOS_AGENTE: readonly GrupoDef[] = [
  { id: 'configurar', rotulo: 'Configurar', subs: [
    { id: 'configuracao', rotulo: 'Configuração' },
    { id: 'protecoes', rotulo: 'Proteções' },
  ] },
  { id: 'ensinar', rotulo: 'Ensinar', subs: [
    { id: 'conhecimento', rotulo: 'Conhecimento' },
    { id: 'playbook', rotulo: 'Playbook' },
  ] },
  { id: 'testar', rotulo: 'Testar', subs: [{ id: 'playground', rotulo: 'Playground' }] },
  { id: 'acompanhar', rotulo: 'Acompanhar', subs: [
    { id: 'sessoes', rotulo: 'Sessões' },
    { id: 'decisoes', rotulo: 'Decisões' },
  ] },
  { id: 'medir', rotulo: 'Qualidade', subs: [
    { id: 'qualidade', rotulo: 'Qualidade' },
    { id: 'revisao', rotulo: 'Revisão' },
    { id: 'metricas', rotulo: 'Métricas' },
  ] },
]

/** Prontidão por sub-seção; ausente = pronta (as que não são de raia). */
export type Prontas = Readonly<Partial<Record<SubAgente, boolean>>>

/** Os grupos visíveis, cada um só com as sub-seções prontas; grupo vazio some. */
export function gruposVisiveis(prontas: Prontas): readonly GrupoDef[] {
  return GRUPOS_AGENTE
    .map((g) => ({ ...g, subs: g.subs.filter((s) => prontas[s.id] !== false) }))
    .filter((g) => g.subs.length > 0)
}

export interface Secao { readonly grupo: GrupoAgente; readonly sub: SubAgente }

/**
 * Do endereço para a seção. Aceita o formato novo (`?aba=ensinar&sub=playbook`)
 * e o antigo, de quando cada sub-seção era uma aba (`?aba=playbook` — o atalho
 * das Configurações usa). Desconhecido ou não pronto cai na primeira seção.
 */
export function secaoDoEndereco(aba: string | null, sub: string | null, grupos: readonly GrupoDef[]): Secao {
  const primeira = grupos[0]
  const padrao: Secao = { grupo: primeira?.id ?? 'configurar', sub: primeira?.subs[0]?.id ?? 'configuracao' }
  const grupo = grupos.find((g) => g.id === aba)
  if (grupo) {
    const s = grupo.subs.find((x) => x.id === sub) ?? grupo.subs[0]!
    return { grupo: grupo.id, sub: s.id }
  }
  // Formato antigo: `aba` era o id da sub-seção.
  for (const g of grupos) {
    const s = g.subs.find((x) => x.id === aba)
    if (s) return { grupo: g.id, sub: s.id }
  }
  return padrao
}

/** A seção ao trocar de grupo: a primeira sub-seção dele. */
export function secaoDoGrupo(grupo: string, grupos: readonly GrupoDef[]): Secao | null {
  const g = grupos.find((x) => x.id === grupo)
  return g ? { grupo: g.id, sub: g.subs[0]!.id } : null
}

/** O que vai no endereço: só o grupo quando a sub-seção é a primeira (endereço curto). */
export function enderecoDaSecao(s: Secao, grupos: readonly GrupoDef[]): { aba: string; sub: string | null } {
  const g = grupos.find((x) => x.id === s.grupo)
  return { aba: s.grupo, sub: g && g.subs[0]?.id === s.sub ? null : s.sub }
}

/**
 * Trocar de número no cabeçalho com alterações não salvas no Configurar pede
 * confirmação: o formulário recarrega do número novo e a edição se perderia.
 * Escolher o mesmo número (ou trocar sem alteração) passa direto.
 */
export function precisaConfirmarTroca(atual: string, novo: string, alterado: boolean): boolean {
  return alterado && novo !== atual
}
