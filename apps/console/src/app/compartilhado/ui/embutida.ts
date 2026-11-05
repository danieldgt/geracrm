import { InjectionToken } from '@angular/core'

/**
 * A tela está EMBUTIDA como aba de uma tela com abas (`TelaAbasPagina`).
 *
 * ⚠️ Quem provê é a tela com abas, no próprio elemento: a tela filha (carregada
 * no `router-outlet`) herda pelo injetor de elemento. Com isto o `ui-cabecalho-tela`
 * da filha esconde título e subtítulo — quem diz o nome é a tela de cima — e
 * mantém só as ações. A tela filha não muda uma linha para virar aba.
 */
export const TELA_EMBUTIDA = new InjectionToken<boolean>('TELA_EMBUTIDA')
