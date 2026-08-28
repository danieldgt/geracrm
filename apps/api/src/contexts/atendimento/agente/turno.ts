import { randomUUID } from 'node:crypto'
import { REGRAS_AGENTE_PADRAO, type RegrasDoAgente } from '@geracrm/shared'
import { comTenantServico, type Sql } from '../../../db/index.js'
import { enviarTextoNaConversa } from '../envio-conversa.js'
import { quemAtende, ninguemDisponivel, motivoDisponibilidade } from '../disponibilidade.js'
import { fragmentoAtendentePresente } from '../presenca-atendente.js'
import { carregarContextoDoLead } from './contexto-lead.js'
import { validarExtracao } from './extracao.js'
import { llmDoAmbiente } from './fabrica.js'
import { portaoDoAgente, type MotivoNaoEntra } from './portao.js'
import type { Fala, PortaLlm } from './porta.js'

/**
 * UM TURNO DO AGENTE — a ligação entre a mensagem que chegou e o que sai.
 *
 * ⚠️ **Pós-commit e best-effort**, como a resposta de ausência: a mensagem do
 * cliente JÁ está salva quando isto roda. Nada aqui pode derrubar o 200 do
 * webhook — falhar aqui faria o provedor reenviar a mensagem do cliente em
 * loop por causa de uma cortesia que não saiu.
 *
 * ⚠️ Quando o modelo falha, o cliente NÃO fica sem resposta: a ausência já
 * falou antes (é o gatilho, §4.3.1 do escopo). Essa é a degradação desenhada —
 * agente fora do ar deixa exatamente o comportamento de hoje.
 */

/**
 * ⚠️ As três constantes que moravam aqui — falas de contexto, validade da
 * ausência e tamanho da resposta — viraram colunas de `agente_config` (0078).
 * Os padrões continuam existindo, em `REGRAS_AGENTE_PADRAO`, e valem para o
 * canal que nunca abriu a tela. Mudar o agente deixou de exigir deploy.
 */

export type ResultadoTurno =
  | { readonly falou: true; readonly encerrouPor: string | null }
  | { readonly falou: false; readonly motivo: MotivoNaoEntra | 'sem_lead' | 'modelo_falhou' | 'envio_recusado' }

interface Reuniao {
  readonly ausencia_ja_enviada: boolean
  readonly atendente_presente: boolean
  readonly sessao_id: string | null
  readonly sessao_turnos: number | null
  readonly sessao_ja_encerrada: boolean
}

/** A configuração do canal: o botão de desligar, a base curada e as regras. */
interface ConfigDoCanal {
  readonly ativo: boolean
  readonly politicas: string | null
  readonly regras: RegrasDoAgente
}

export async function conduzirTurno(
  tenantId: string, conversaId: string, canalId: string,
  agora: Date = new Date(),
  // ⚠️ Costuras de teste, no mesmo estilo do `{ buscar }` dos adaptadores: sem
  //    elas, testar o orquestrador chamaria o fornecedor de IA E o WhatsApp de
  //    verdade — dinheiro, lentidão e falha por rede oscilante.
  deps: { readonly llm?: PortaLlm; readonly enviar?: typeof enviarTextoNaConversa } = {},
): Promise<ResultadoTurno> {
  // ⚠️ A CONFIG VEM PRIMEIRO, e numa consulta própria — é a mudança que o 0078
  //    trouxe. A régua de presença deixou de ser constante e virou dado; um
  //    predicado SQL não pode usar um número que ainda não foi lido. É um SELECT
  //    por chave primária, e ele decide as duas consultas seguintes.
  const dados = await comTenantServico(tenantId, async (tx) => {
    const cfg = await lerConfigDoCanal(tx, canalId)
    if (!cfg) return null
    return {
      cfg,
      reuniao: await reunirContexto(tx, conversaId, agora, cfg.regras),
      equipe: await quemAtende(tx, canalId, agora),
    }
  })
  if (!dados) return { falou: false, motivo: 'agente_desligado' }
  const { cfg, reuniao, equipe } = dados

  const decisao = portaoDoAgente({
    agenteAtivo: cfg.ativo,
    // ⚠️ "Ninguém para atender ESTE número" — todos ausentes, ninguém logado, ou
    //    a loja fechada. Ver `disponibilidade.ts` para a regra e o porquê.
    ninguemDisponivel: ninguemDisponivel(equipe),
    ausenciaJaEnviada: reuniao.ausencia_ja_enviada,
    atendentePresente: reuniao.atendente_presente,
    sessaoAtiva: reuniao.sessao_id ? { turnos: reuniao.sessao_turnos ?? 0 } : null,
    sessaoJaEncerrada: reuniao.sessao_ja_encerrada,
    maxTurnos: cfg.regras.maxTurnos,
    regras: cfg.regras,
  })

  if (!decisao.entra) {
    // ⚠️ Bater no teto de turnos ENCERRA a sessão com motivo — senão ela ficaria
    //    aberta para sempre, e a conversa nunca chegaria ao humano.
    if (decisao.motivo === 'teto_de_turnos' && reuniao.sessao_id) {
      await comTenantServico(tenantId, (tx) =>
        encerrarSessao(tx, reuniao.sessao_id!, 'teto de turnos sem qualificar', agora))
    }
    return { falou: false, motivo: decisao.motivo }
  }

  const [lead, historico] = await comTenantServico(tenantId, async (tx) => [
    await carregarContextoDoLead(tx, conversaId),
    await carregarHistorico(tx, conversaId, cfg.regras.falasDeContexto),
  ] as const)
  if (!lead) return { falou: false, motivo: 'sem_lead' }

  const llm = deps.llm ?? llmDoAmbiente()
  const r = await llm.conversar({
    historico, lead, politicas: cfg.politicas ?? '', maxCaracteres: cfg.regras.maxCaracteres,
  })

  if (!r.ok) {
    // ⚠️ Encerra com o motivo do fornecedor. A conversa fica para o humano de
    //    manhã, e o cliente já recebeu a ausência — ninguém ficou no vácuo.
    if (reuniao.sessao_id) {
      await comTenantServico(tenantId, (tx) =>
        encerrarSessao(tx, reuniao.sessao_id!, `modelo falhou: ${r.motivo}`, agora))
    }
    return { falou: false, motivo: 'modelo_falhou' }
  }

  const extraido = validarExtracao(r.dados.extraidoBruto)

  // ⚠️ Fala pelo GATEWAY ÚNICO, como todo mundo: opt-out, estado do canal e
  //    credencial são checados lá (INV-50). O agente não tem caminho paralelo.
  const envio = await (deps.enviar ?? enviarTextoNaConversa)(
    tenantId, conversaId, r.dados.texto.slice(0, cfg.regras.maxCaracteres), null, agora,
    { ehDisparo: false, marcador: 'agente' },
  )
  if (!envio.ok) return { falou: false, motivo: 'envio_recusado' }

  const encerrouPor = r.dados.proximoPasso === 'continuar' ? null : (r.dados.motivo || r.dados.proximoPasso)
  // ⚠️ Por que o agente pôde assumir, guardado junto da sessão: depois, "por que
  //    o robô falou com o meu cliente às 14h?" tem resposta sem reconstruir o
  //    estado da equipe naquele minuto — que já passou.
  const porQueAssumiu = motivoDisponibilidade(equipe)

  await comTenantServico(tenantId, async (tx) => {
    const sessaoId = reuniao.sessao_id ?? randomUUID()
    if (!reuniao.sessao_id) {
      await tx`
        INSERT INTO agente_sessao (tenant_id, id, conversa_id, canal_id, iniciada_em, motivo_entrada)
        VALUES (tenant_atual(), ${sessaoId}, ${conversaId}, ${canalId}, ${agora}, ${porQueAssumiu})`
    }
    await tx`
      UPDATE agente_sessao
         SET turnos = turnos + 1,
             extraido = ${JSON.stringify(semDescartados(extraido))}::text::jsonb,
             descartados = descartados || ${JSON.stringify(extraido.descartados)}::text::jsonb,
             tokens_entrada = tokens_entrada + ${r.custo.tokensEntrada},
             tokens_saida   = tokens_saida   + ${r.custo.tokensSaida}
       WHERE tenant_id = tenant_atual() AND id = ${sessaoId}`
    if (encerrouPor) await encerrarSessao(tx, sessaoId, encerrouPor, agora)
  })

  return { falou: true, encerrouPor }
}

/**
 * A CONFIGURAÇÃO DO CANAL — o botão de desligar, a base curada e as regras.
 *
 * ⚠️ Linha ausente é agente DESLIGADO, não agente com padrões. Ligar exige um
 * ato explícito na tela (que também exige políticas escritas); um canal que
 * nunca foi configurado não pode começar a falar com clientes porque uma
 * migration deu defaults a ele.
 *
 * ⚠️ As regras vêm com `coalesce` para o padrão mesmo assim: a coluna é NOT NULL
 * DEFAULT no 0078, mas o código não fica dependendo disso — a versão anterior da
 * API convive com esta durante o deploy, e é ela quem escreve a linha.
 */
async function lerConfigDoCanal(tx: Sql, canalId: string): Promise<ConfigDoCanal | null> {
  const [l] = await tx<{
    ativo: boolean; politicas: string | null
    so_quando_ninguem_disponivel: boolean; exigir_ausencia_antes: boolean
    horas_desde_ausencia: number; reabrir_apos_encerrada: boolean
    minutos_presenca: number; max_turnos: number
    max_caracteres: number; falas_de_contexto: number
  }[]>`
    SELECT ativo, politicas,
           so_quando_ninguem_disponivel, exigir_ausencia_antes,
           horas_desde_ausencia, reabrir_apos_encerrada,
           minutos_presenca, max_turnos, max_caracteres, falas_de_contexto
      FROM agente_config
     WHERE tenant_id = tenant_atual() AND canal_id = ${canalId}`
  if (!l) return null

  const p = REGRAS_AGENTE_PADRAO
  return {
    ativo: l.ativo,
    politicas: l.politicas,
    regras: {
      soQuandoNinguemDisponivel: l.so_quando_ninguem_disponivel ?? p.soQuandoNinguemDisponivel,
      exigirAusenciaAntes: l.exigir_ausencia_antes ?? p.exigirAusenciaAntes,
      horasDesdeAusencia: l.horas_desde_ausencia ?? p.horasDesdeAusencia,
      reabrirAposEncerrada: l.reabrir_apos_encerrada ?? p.reabrirAposEncerrada,
      minutosPresenca: l.minutos_presenca ?? p.minutosPresenca,
      maxTurnos: l.max_turnos ?? p.maxTurnos,
      maxCaracteres: l.max_caracteres ?? p.maxCaracteres,
      falasDeContexto: l.falas_de_contexto ?? p.falasDeContexto,
    },
  }
}

/**
 * O estado da CONVERSA que a decisão precisa, numa consulta só.
 *
 * ⚠️ A régua de presença vem do fragmento compartilhado com a resposta de
 * ausência — agora com o número que o canal configurou. O que se compartilha é
 * o predicado; duas cópias DELE divergiriam, e o sintoma seria o robô falando
 * por cima de um atendente.
 */
async function reunirContexto(
  tx: Sql, conversaId: string, agora: Date, regras: RegrasDoAgente,
): Promise<Reuniao> {
  const [linha] = await tx<Reuniao[]>`
    SELECT EXISTS (SELECT 1 FROM mensagem m
                    WHERE m.tenant_id = tenant_atual() AND m.conversa_id = ${conversaId}
                      AND m.direcao = 'saliente'
                      AND m.conteudo->>'automatica' = 'ausencia'
                      AND m.criado_em > ${agora}::timestamptz
                          - make_interval(hours => ${regras.horasDesdeAusencia})) AS ausencia_ja_enviada,
           ${fragmentoAtendentePresente(tx, conversaId, agora, regras.minutosPresenca)} AS atendente_presente,
           (SELECT s.id     FROM agente_sessao s
             WHERE s.tenant_id = tenant_atual() AND s.conversa_id = ${conversaId}
               AND s.estado = 'ativa') AS sessao_id,
           (SELECT s.turnos FROM agente_sessao s
             WHERE s.tenant_id = tenant_atual() AND s.conversa_id = ${conversaId}
               AND s.estado = 'ativa') AS sessao_turnos,
           EXISTS (SELECT 1 FROM agente_sessao s
                    WHERE s.tenant_id = tenant_atual() AND s.conversa_id = ${conversaId}
                      AND s.estado <> 'ativa') AS sessao_ja_encerrada`
  // ⚠️ Sem `FROM`, a consulta devolve exatamente uma linha — os EXISTS e os
  //    subselects já são escalares. O `FROM tenant` de antes existia só para
  //    pendurar o LEFT JOIN da config, que agora tem consulta própria.
  return linha!
}

/**
 * As últimas falas, em ordem cronológica.
 *
 * ⚠️ A resposta de ausência entra como fala nossa, de propósito: sem ela o
 * modelo não sabe que o cliente já foi avisado do horário e repete a informação
 * na primeira frase.
 */
async function carregarHistorico(
  tx: Sql, conversaId: string, falas: number,
): Promise<readonly Fala[]> {
  const linhas = await tx<{ direcao: string; texto: string | null }[]>`
    SELECT direcao, conteudo->>'texto' AS texto
      FROM mensagem
     WHERE tenant_id = tenant_atual() AND conversa_id = ${conversaId}
       AND conteudo->>'texto' IS NOT NULL
     ORDER BY criado_em DESC
     LIMIT ${falas}`
  return linhas
    .reverse()
    .map((l) => ({ de: l.direcao === 'entrante' ? 'cliente' : 'nos', texto: l.texto! } as const))
}

async function encerrarSessao(tx: Sql, sessaoId: string, motivo: string, agora: Date): Promise<void> {
  await tx`
    UPDATE agente_sessao
       SET estado = 'entregue', motivo_saida = ${motivo.slice(0, 200)}, encerrada_em = ${agora}
     WHERE tenant_id = tenant_atual() AND id = ${sessaoId} AND estado = 'ativa'`
}

/** O que foi aceito, sem a lista de recusas (que vai em coluna própria). */
function semDescartados(e: ReturnType<typeof validarExtracao>) {
  const { descartados: _, ...aceito } = e
  return aceito
}
