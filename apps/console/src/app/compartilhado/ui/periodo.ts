export type AtalhoPeriodo = 'hoje' | '7dias' | '30dias' | 'mesAtual' | 'mesPassado'
export interface Periodo { inicio: string; fim: string }

export const ATALHOS_PERIODO: readonly { chave: AtalhoPeriodo; rotulo: string }[] = [
  { chave: 'hoje', rotulo: 'Hoje' },
  { chave: '7dias', rotulo: '7 dias' },
  { chave: '30dias', rotulo: '30 dias' },
  { chave: 'mesAtual', rotulo: 'Mês atual' },
  { chave: 'mesPassado', rotulo: 'Mês passado' },
]

// ⚠️ Tudo em UTC sobre a string ISO: new Date('yyyy-mm-dd') + fuso local escorrega um dia.
function partes(iso: string): [number, number, number] {
  const [a = 0, m = 1, d = 1] = iso.split('-').map(Number)
  return [a, m, d]
}
function iso(ms: number): string { return new Date(ms).toISOString().slice(0, 10) }
function utc(a: number, m: number, d: number): number { return Date.UTC(a, m - 1, d) }
const DIA = 86_400_000

function mes(ano: number, m: number): Periodo {
  // Date.UTC normaliza mês 0 / 13; dia 0 do mês seguinte é o último do mês.
  return { inicio: iso(utc(ano, m, 1)), fim: iso(utc(ano, m + 1, 0)) }
}

/** Intervalo (inclusivo) de um atalho, dado "hoje" em ISO yyyy-mm-dd. Função pura. */
export function periodoDoAtalho(atalho: AtalhoPeriodo, hoje: string): Periodo {
  const [a, m, d] = partes(hoje)
  switch (atalho) {
    case 'hoje': return { inicio: hoje, fim: hoje }
    case '7dias': return { inicio: iso(utc(a, m, d) - 6 * DIA), fim: hoje }
    case '30dias': return { inicio: iso(utc(a, m, d) - 29 * DIA), fim: hoje }
    case 'mesAtual': return mes(a, m)
    case 'mesPassado': return mes(a, m - 1)
  }
}

/** Qual atalho corresponde exatamente ao intervalo, ou null (intervalo livre). */
export function atalhoAtivo(inicio: string, fim: string, hoje: string): AtalhoPeriodo | null {
  for (const { chave } of ATALHOS_PERIODO) {
    const p = periodoDoAtalho(chave, hoje)
    if (p.inicio === inicio && p.fim === fim) return chave
  }
  return null
}

/** Hoje no fuso local, em ISO yyyy-mm-dd. */
export function hojeIso(agora: Date = new Date()): string {
  const z = (n: number): string => String(n).padStart(2, '0')
  return `${agora.getFullYear()}-${z(agora.getMonth() + 1)}-${z(agora.getDate())}`
}

/** Período invertido: início depois do fim (ISO yyyy-mm-dd compara certo como texto). Vazio nunca é inválido. */
export function periodoInvertido(inicio: string, fim: string): boolean {
  return inicio !== '' && fim !== '' && inicio > fim
}
