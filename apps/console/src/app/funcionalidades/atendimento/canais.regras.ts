/**
 * Regras de apresentação da tela de números — puras, para poderem ser testadas
 * sem montar componente.
 */

/**
 * A área avançada (credencial do fornecedor) fica FECHADA por padrão: no canal
 * não-oficial a instância pertence ao contrato da Drezz, e quem está conectando
 * o próprio WhatsApp não tem esses dados.
 *
 * ⚠️ Mas ela ABRE SOZINHA quando o servidor recusa um campo de credencial.
 * Erro apontando para campo escondido é erro invisível: a pessoa vê "Confira os
 * campos destacados" e não há campo destacado na tela.
 *
 * ⚠️ E por isso o clique não fecha enquanto houver erro — fechar esconderia
 * exatamente a mensagem que precisa ser lida.
 */
export function abrirAvancado(
  erros: Readonly<Record<string, string>>,
  camposCredencial: readonly string[],
  abertoManual: boolean,
): boolean {
  if (abertoManual) return true
  return camposCredencial.some((campo) => erros[campo] !== undefined)
}
