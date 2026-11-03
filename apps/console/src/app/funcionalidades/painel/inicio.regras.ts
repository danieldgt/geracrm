/** Regras puras do Início v2 (testadas em inicio.regras.spec.ts). */

/** Hora cheia (0-23) do instante no fuso; fuso ausente ou inválido cai na hora local do navegador. */
export function horaNoFuso(agora: Date, fuso: string | null): number {
  if (fuso) {
    try {
      const h = new Intl.DateTimeFormat('en-US', { timeZone: fuso, hour: 'numeric', hourCycle: 'h23' }).format(agora)
      const n = Number(h)
      if (Number.isInteger(n)) return n % 24
    } catch {
      // fuso desconhecido: cai na hora local
    }
  }
  return agora.getHours()
}

/** Bom dia (05-11h), Boa tarde (12-17h), Boa noite (18-04h), pela hora no fuso do tenant. */
export function saudacaoPorHora(hora: number): 'Bom dia' | 'Boa tarde' | 'Boa noite' {
  if (hora >= 5 && hora < 12) return 'Bom dia'
  if (hora >= 12 && hora < 18) return 'Boa tarde'
  return 'Boa noite'
}

/** "Boa tarde, Daniel" (só o primeiro nome); sem nome, só a saudação. */
export function textoSaudacao(agora: Date, fuso: string | null, nome: string | null): string {
  const s = saudacaoPorHora(horaNoFuso(agora, fuso))
  const primeiro = nome?.trim().split(/\s+/)[0]
  return primeiro ? `${s}, ${primeiro}` : s
}

const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']

/** "2026-09" vira "set/26". */
export function rotuloMes(mes: string): string {
  const [ano = '', m = ''] = mes.split('-')
  return `${MESES[Number(m) - 1] ?? m}/${ano.slice(2)}`
}

/** Altura (%) das colunas do gráfico de pedidos por mês: a maior = 100%, zero = 0, positivo >= 4%. */
export function alturasColunas(valores: readonly number[]): number[] {
  const maior = valores.reduce((m, v) => Math.max(m, v), 0)
  return valores.map((v) => (maior <= 0 || v <= 0 ? 0 : Math.max(4, Math.round((v / maior) * 1000) / 10)))
}

/** "03/11 14:30" no fuso do tenant (fuso inválido usa o do navegador). */
export function dataHoraCurta(iso: string, fuso: string | null): string {
  const d = new Date(iso)
  const opcoes: Intl.DateTimeFormatOptions = { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
  try {
    return new Intl.DateTimeFormat('pt-BR', fuso ? { ...opcoes, timeZone: fuso } : opcoes).format(d).replace(',', '')
  } catch {
    return new Intl.DateTimeFormat('pt-BR', opcoes).format(d).replace(',', '')
  }
}
