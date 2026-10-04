import { Component, ChangeDetectionStrategy, computed, effect, inject, input, output, signal, untracked } from '@angular/core'
import { RouterLink } from '@angular/router'
import {
  MODOS_AGENTE, ROTULO_MODO, OBJETIVOS_AGENTE, TONS, SLOTS_QUALIFICACAO, REGRAS_AGENTE_PADRAO,
  avisosDasRegras, type ModoAgente, type RegrasDoAgente,
} from '@geracrm/shared'
import {
  BotaoComponente, CampoComponente, PainelComponente, EsqueletoComponente, EstadoComponente, BadgeComponente,
  QualidadeComponente, ToastServico, agruparPorPreco, linhaDeCusto, rotuloProvedor, type ModeloIa,
} from '../../../compartilhado/ui/index.js'
import { AgenteServico, ehSemPermissao, type ConfigAgente } from './agente.servico.js'
import {
  EXPLICACAO_MODO, FAIXAS_AVANCADO, FAIXAS_REGRAS_AGENTE, ROTULO_OBJETIVO, ROTULO_SLOT, ROTULO_TOM,
  badgeModo, centavosParaTexto, corpoParaSalvar, errosDoServidor, mudouDoPadrao, validarFormulario,
  type FormularioAgente,
} from './agente.regras.js'
import {
  MODELO_PADRAO_DO_SERVIDOR, escolhaForaDaLista, opcaoPadraoDoServidor, podeEscolher, type CatalogoDoTenant,
} from './modelos.regras.js'
import { ConhecimentoServico } from './conhecimento.servico.js'
import { fraseCapacidade } from './conhecimento.regras.js'

type Estado = 'carregando' | 'pronto' | 'erro' | 'sem_permissao'
/** O seletor de modelo carrega à parte: se falhar, o resto do formulário segue de pé (parcial). */
type EstadoModelos = 'carregando' | 'pronto' | 'erro'

/**
 * Configuração do agente vendedor num número: modo, persona, objetivo, alçada,
 * políticas, regras de entrada e o avançado.
 *
 * ⚠️ Erro aparece NO CAMPO, antes do clique (mesmos limites da API, via
 * `validarFormulario`) e depois dele (422 mapeado por `errosDoServidor`). O
 * banner genérico fica só para o que não tem campo — a chave que falta no
 * servidor, por exemplo, que a tela nomeia pela variável.
 */
@Component({
  selector: 'app-agente-config',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink, BotaoComponente, CampoComponente, PainelComponente, EsqueletoComponente, EstadoComponente,
    BadgeComponente, QualidadeComponente,
  ],
  template: `
    @switch (estado()) {
      @case ('carregando') {
        <ui-painel>
          <div class="esq-lista">
            <ui-esqueleto altura="20px" largura="40%" />
            <ui-esqueleto altura="72px" /><ui-esqueleto altura="72px" />
            <ui-esqueleto altura="20px" largura="30%" />
            <ui-esqueleto altura="40px" /><ui-esqueleto altura="40px" />
          </div>
        </ui-painel>
      }
      @case ('sem_permissao') {
        <ui-painel><ui-estado tipo="sem-permissao" titulo="Sem acesso à configuração do agente"
          descricao="Peça a um administrador para liberar." /></ui-painel>
      }
      @case ('erro') {
        <ui-painel><ui-estado tipo="erro" titulo="Não foi possível carregar a configuração"
          descricao="O servidor não respondeu. Dá para tentar de novo.">
          <ui-botao variante="secundario" (click)="carregar()">Tentar de novo</ui-botao>
        </ui-estado></ui-painel>
      }
      @case ('pronto') {
        @if (cfg(); as c) {
          <form class="form" (submit)="salvar($event)" novalidate>

            <!-- ⚠️ O que falta aparece com o NOME da variável: erro genérico manda
                 abrir chamado, nome manda resolver. -->
            @if (c.faltaConfigurar.length > 0) {
              <div class="aviso" role="alert">Falta configurar no servidor:
                <strong class="txt-dados">{{ c.faltaConfigurar.join(', ') }}</strong>. Até lá o agente só pode ficar desligado.</div>
            }
            @if (erroGeral(); as g) { <div class="aviso aviso--erro" role="alert">{{ g }}</div> }

            <!-- (a) Modo -->
            <ui-painel>
              <h2 class="txt-secao secao">Modo</h2>
              <p class="dica topo">Comece em sombra, passe para assistido e só então deixe autônomo — por número.</p>
              <div class="modos" role="radiogroup" aria-label="Modo do agente">
                @for (m of modos; track m) {
                  <label class="modo" [class.sel]="f().modo === m" [class.off]="bloqueiaModo(m)">
                    <input type="radio" name="modo" [value]="m" [checked]="f().modo === m"
                           [disabled]="bloqueiaModo(m)" (change)="mudarModo(m)" />
                    <span class="modo-txt encolhe">
                      <span class="modo-rot">{{ rotuloModo[m] }}</span>
                      <span class="modo-exp">{{ explicacao[m] }}</span>
                    </span>
                  </label>
                }
              </div>
            </ui-painel>

            <!-- (a2) Modelo de IA — o cliente escolhe o modelo; a chave é do servidor e nunca aparece.
                 ⚠️ Carrega à parte do formulário: se a lista falhar, o resto segue editável (parcial). -->
            <ui-painel>
              <h2 class="txt-secao secao" id="rot-modelo">Modelo de IA</h2>
              <p class="dica topo">Qual modelo responde neste número. Quem libera os modelos da sua conta é a Gera3 — e a chave de cada fornecedor fica no servidor.</p>
              @switch (estadoModelos()) {
                @case ('carregando') {
                  <div class="esq-lista" aria-busy="true">
                    <ui-esqueleto altura="64px" /><ui-esqueleto altura="64px" /><ui-esqueleto altura="64px" />
                  </div>
                }
                @case ('erro') {
                  <div class="aviso aviso--erro" role="alert">
                    Não foi possível carregar a lista de modelos. O modelo salvo continua valendo; dá para tentar de novo.
                    <div class="topo-2"><ui-botao variante="secundario" (click)="carregarModelos()">Tentar de novo</ui-botao></div>
                  </div>
                }
                @case ('pronto') {
                  @if (catalogo(); as cat) {
                    <div class="modelos" role="radiogroup" aria-labelledby="rot-modelo"
                         [attr.aria-invalid]="erroDe('modelo') ? 'true' : null"
                         [attr.aria-describedby]="erroDe('modelo') ? 'erro-modelo' : null">

                      <!-- Primeira opção, sempre: o padrão do servidor (ou o aviso do que falta). -->
                      @if (opcaoPadrao(); as p) {
                        <label class="modo card-modelo" [class.sel]="f().modelo === padraoDoServidor" [class.off]="!p.disponivel">
                          <input type="radio" name="modelo" [value]="padraoDoServidor" [checked]="f().modelo === padraoDoServidor"
                                 [disabled]="!p.disponivel" (change)="escolherModelo(padraoDoServidor)" />
                          <span class="modo-txt encolhe">
                            <span class="modo-rot">{{ p.rotulo }}</span>
                            <span class="modo-exp" [class.alerta]="!p.disponivel">{{ p.explicacao }}</span>
                          </span>
                        </label>
                      }

                      <!-- ⚠️ O código salvo saiu da lista (restrição posterior): não some em silêncio. -->
                      @if (foraDaLista(); as fora) {
                        <label class="modo card-modelo sel off">
                          <input type="radio" name="modelo" [value]="fora" checked disabled />
                          <span class="modo-txt encolhe">
                            <span class="modo-rot">Modelo salvo: <span class="txt-dados">{{ fora }}</span></span>
                            <span class="modo-exp alerta">Não está mais liberado para a sua conta. Escolha outro abaixo antes de salvar — ou fale com o suporte.</span>
                          </span>
                        </label>
                      }

                      @if (cat.itens.length === 0) {
                        <p class="dica vazio-modelos">Nenhum modelo liberado além do padrão — fale com o suporte para liberar outros.</p>
                      }

                      @for (g of grupos(); track g.titulo) {
                        @if (g.itens.length > 0) {
                          @if (mostraTitulos()) { <h3 class="txt-rotulo grupo">{{ g.titulo }}</h3> }
                          @for (m of g.itens; track m.codigo) {
                            <label class="modo card-modelo" [class.sel]="f().modelo === m.codigo" [class.off]="!pode(m)">
                              <input type="radio" name="modelo" [value]="m.codigo" [checked]="f().modelo === m.codigo"
                                     [disabled]="!pode(m)" (change)="escolherModelo(m.codigo)" />
                              <span class="modo-txt encolhe">
                                <!-- Badges em ORDEM FIXA: preço, ferramentas, saída estruturada. -->
                                <span class="linha-modelo">
                                  <span class="modo-rot encolhe">{{ m.nome }}</span>
                                  <ui-badge [tom]="m.gratuito ? 'sucesso' : 'neutro'">{{ m.gratuito ? 'Grátis' : 'Pago' }}</ui-badge>
                                  @if (m.ferramentas) { <ui-badge tom="info">ferramentas</ui-badge> }
                                  @if (m.saidaEstruturada) { <ui-badge tom="info">saída estruturada</ui-badge> }
                                </span>
                                <span class="meta-modelo">
                                  <span>{{ provedor(m.provedor) }}</span>
                                  <ui-qualidade [valor]="m.qualidade" />
                                  @if (custo(m); as c) { <span class="txt-dados">{{ c }}</span> }
                                </span>
                                @if (m.descricao) { <span class="modo-exp">{{ m.descricao }}</span> }
                                @if (m.observacao) { <span class="obs">{{ m.observacao }}</span> }
                                @if (!m.disponivel) {
                                  <span class="modo-exp alerta">Indisponível: <span class="txt-dados">{{ m.motivoIndisponivel ?? 'sem chave no servidor' }}</span></span>
                                }
                              </span>
                            </label>
                          }
                        }
                      }
                    </div>
                    @if (erroDe('modelo'); as e) { <span class="msg-erro" id="erro-modelo" role="alert">{{ e }}</span> }
                    <p class="dica">Trocar de modelo vale a partir da próxima mensagem. Cada decisão registra qual modelo respondeu.</p>
                  }
                }
              }
            </ui-painel>

            <!-- (b) Persona -->
            <ui-painel>
              <h2 class="txt-secao secao">Persona</h2>
              <div class="grade-2">
                <ui-campo rotulo="Nome do agente" [valor]="f().persona.nome" (valorChange)="mudarPersona('nome', $event)"
                          [erro]="erroDe('persona.nome')" placeholder="Ex.: Ana" />
                <ui-campo rotulo="Nome da loja" [valor]="f().persona.loja" (valorChange)="mudarPersona('loja', $event)"
                          [erro]="erroDe('persona.loja')" placeholder="Como o cliente conhece a loja" />
                <label class="campo">
                  <span>Tom de voz</span>
                  <select [value]="f().persona.tom" (change)="mudarPersona('tom', $any($event.target).value)">
                    @for (t of tons; track t) { <option [value]="t">{{ rotuloTom[t] }}</option> }
                  </select>
                </label>
                <ui-campo rotulo="Saudação (opcional)" [valor]="f().persona.saudacao" (valorChange)="mudarPersona('saudacao', $event)"
                          [erro]="erroDe('persona.saudacao')" placeholder="Primeira frase quando ele abre a conversa" />
              </div>
              <label class="chk">
                <input type="checkbox" [checked]="f().persona.usaEmojis" (change)="mudarPersona('usaEmojis', $any($event.target).checked)" />
                Usa emojis
              </label>
              <label class="chk">
                <input type="checkbox" [checked]="f().persona.identificaComoRobo" (change)="mudarPersona('identificaComoRobo', $any($event.target).checked)" />
                Se apresenta como atendimento automatizado
              </label>
              <p class="dica">A Meta exige que o cliente saiba quando fala com um robô. Desligar isto no canal oficial pode custar a qualidade do número.</p>
            </ui-painel>

            <!-- (c) Objetivo + qualificação -->
            <ui-painel>
              <h2 class="txt-secao secao">Objetivo</h2>
              <div class="objetivos" role="radiogroup" aria-label="Objetivo do agente">
                @for (o of objetivos; track o) {
                  <label class="modo" [class.sel]="f().objetivo === o">
                    <input type="radio" name="objetivo" [value]="o" [checked]="f().objetivo === o" (change)="mudar('objetivo', o)" />
                    <span class="modo-rot encolhe">{{ rotuloObjetivo[o] }}</span>
                  </label>
                }
              </div>
              <h3 class="txt-corpo sub">O que ele pergunta antes de recomendar</h3>
              <p class="dica">Campos, não roteiro: ele não pergunta o que já sabe do cliente.</p>
              <div class="slots">
                @for (s of slots; track s) {
                  <label class="chk">
                    <input type="checkbox" [checked]="f().qualificacao.includes(s)" (change)="alternarSlot(s, $any($event.target).checked)" />
                    {{ rotuloSlot[s] }}
                  </label>
                }
              </div>
            </ui-painel>

            <!-- (d) Alçada -->
            <ui-painel>
              <h2 class="txt-secao secao">Alçada</h2>
              <p class="dica topo">Por padrão <strong>tudo espera um vendedor</strong>: o cliente confirma, o pedido fica pronto e alguém da equipe efetiva. Só mude se quiser que ele feche sozinho.</p>
              <div class="grade-2">
                <label class="campo">
                  <span>Valor máximo que ele efetiva sozinho (R$)</span>
                  <input type="text" inputmode="decimal" [value]="f().alcada.valorMaxTexto"
                         (input)="mudarAlcada('valorMaxTexto', $any($event.target).value)"
                         [attr.aria-invalid]="erroDe('alcada.valorMaxAutonomoCentavos') ? 'true' : null" placeholder="0,00" />
                  @if (erroDe('alcada.valorMaxAutonomoCentavos'); as e) { <span class="msg-erro">{{ e }}</span> }
                  <small>Pedido acima disto espera um vendedor, mesmo com o cliente confirmando.</small>
                </label>
                <label class="campo">
                  <span>Desconto máximo (%)</span>
                  <input type="number" [min]="faixasAvancado.descontoMaxPct.min" [max]="faixasAvancado.descontoMaxPct.max" step="0.5"
                         [value]="f().alcada.descontoMaxPct" (input)="mudarAlcada('descontoMaxPct', +$any($event.target).value)"
                         [attr.aria-invalid]="erroDe('alcada.descontoMaxPct') ? 'true' : null" />
                  @if (erroDe('alcada.descontoMaxPct'); as e) { <span class="msg-erro">{{ e }}</span> }
                  <small>Zero por padrão. Desconto pedido acima disto vira entrega ao humano.</small>
                </label>
              </div>
              <label class="chk">
                <input type="checkbox" [checked]="f().alcada.efetivaSozinho" (change)="mudarAlcada('efetivaSozinho', $any($event.target).checked)" />
                Efetiva no ERP sem um vendedor, quando o cliente confirma e o valor cabe na alçada
              </label>
            </ui-painel>

            <!-- (e) Políticas -->
            <ui-painel>
              <h2 class="txt-secao secao">Políticas da loja</h2>
              <label class="campo">
                <span>O que o agente pode afirmar</span>
                <textarea rows="6" [value]="f().politicas" (input)="mudar('politicas', $any($event.target).value)"
                          [attr.aria-invalid]="erroDe('politicas') ? 'true' : null"
                          placeholder="Prazo de entrega, formas de pagamento, troca, pedido mínimo, o que você vende."></textarea>
                @if (erroDe('politicas'); as e) { <span class="msg-erro">{{ e }}</span> }
                <!-- ⚠️ Agente autônomo sem base responde "não sei" a tudo. -->
                <small>Preço e estoque ele busca no catálogo; o resto só responde se estiver aqui. O modo autônomo exige este texto.</small>
              </label>
              <!-- Estado da busca da base de conhecimento (carregado uma vez; falha silenciosa = não aparece). -->
              @if (buscaConhecimento(); as b) {
                <p class="dica busca-estado">Base de conhecimento: {{ b }}.
                  <button type="button" class="link" (click)="abrirConhecimento.emit()">Abrir a aba Conhecimento</button></p>
              }
            </ui-painel>

            <!-- (f) Regras de entrada -->
            <ui-painel>
              <h2 class="txt-secao secao">Quando o agente entra</h2>

              <!-- ⚠️ Dependência INVISÍVEL: com "esperar o cliente insistir" ligado, o
                   gatilho é a mensagem de ausência ter saído. Sem texto escrito para
                   este número ela nunca sai e o robô fica ligado e mudo.
                   Comparação com false, e não negação: console e API sobem separados. -->
              @if (f().regras.exigirAusenciaAntes && c.temMensagemAusencia === false) {
                <div class="aviso">Este número não tem <strong>mensagem de ausência</strong> escrita — e é ela que abre a
                  porta do agente. Enquanto “esperar o cliente insistir” estiver ligado, ele nunca vai responder.
                  Escreva a mensagem em <a routerLink="/canal-config">Config. do Canal</a> ou desligue a regra abaixo.</div>
              }

              <label class="chk">
                <input type="checkbox" [checked]="f().regras.soQuandoNinguemDisponivel"
                       (change)="mudarRegra('soQuandoNinguemDisponivel', $any($event.target).checked)" />
                Só quando ninguém está disponível
              </label>
              <p class="dica">Desligado, ele responde junto com a equipe, em horário comercial.</p>

              <label class="chk">
                <input type="checkbox" [checked]="f().regras.exigirAusenciaAntes"
                       (change)="mudarRegra('exigirAusenciaAntes', $any($event.target).checked)" />
                Esperar o cliente insistir depois da mensagem de ausência
              </label>
              <p class="dica">É o filtro que separa quem tem interesse de quem mandou “oi” e sumiu.</p>

              <label class="chk">
                <input type="checkbox" [checked]="f().regras.reabrirAposEncerrada"
                       (change)="mudarRegra('reabrirAposEncerrada', $any($event.target).checked)" />
                Voltar a falar em conversa que ele já encerrou
              </label>
              <p class="dica">Desligado, ele espera o prazo abaixo antes de voltar àquela conversa — e volta antes se um atendente encerrar o atendimento no meio.</p>

              <div class="grade-3">
                @if (!f().regras.reabrirAposEncerrada) {
                  <label class="campo">
                    <span>Silêncio após encerrar (horas)</span>
                    <input type="number" [min]="faixas.horasParaReabrir.min" [max]="faixas.horasParaReabrir.max"
                           [value]="f().regras.horasParaReabrir" (input)="mudarRegra('horasParaReabrir', +$any($event.target).value)"
                           [attr.aria-invalid]="erroDe('horasParaReabrir') ? 'true' : null" />
                    @if (erroDe('horasParaReabrir'); as e) { <span class="msg-erro">{{ e }}</span> }
                  </label>
                }
                <label class="campo">
                  <span>Validade da ausência (horas)</span>
                  <input type="number" [min]="faixas.horasDesdeAusencia.min" [max]="faixas.horasDesdeAusencia.max"
                         [value]="f().regras.horasDesdeAusencia" (input)="mudarRegra('horasDesdeAusencia', +$any($event.target).value)"
                         [attr.aria-invalid]="erroDe('horasDesdeAusencia') ? 'true' : null" />
                  @if (erroDe('horasDesdeAusencia'); as e) { <span class="msg-erro">{{ e }}</span> }
                </label>
                <label class="campo">
                  <span>Silêncio após um atendente (min)</span>
                  <input type="number" [min]="faixas.minutosPresenca.min" [max]="faixas.minutosPresenca.max"
                         [value]="f().regras.minutosPresenca" (input)="mudarRegra('minutosPresenca', +$any($event.target).value)"
                         [attr.aria-invalid]="erroDe('minutosPresenca') ? 'true' : null" />
                  @if (erroDe('minutosPresenca'); as e) { <span class="msg-erro">{{ e }}</span> }
                </label>
              </div>

              <h3 class="txt-corpo sub">Como ele responde</h3>
              <div class="grade-3">
                <label class="campo">
                  <span>Máximo de idas e vindas</span>
                  <input type="number" [min]="faixas.maxTurnos.min" [max]="faixas.maxTurnos.max"
                         [value]="f().regras.maxTurnos" (input)="mudarRegra('maxTurnos', +$any($event.target).value)"
                         [attr.aria-invalid]="erroDe('maxTurnos') ? 'true' : null" />
                  @if (erroDe('maxTurnos'); as e) { <span class="msg-erro">{{ e }}</span> }
                  <small>Ao bater o teto, entrega ao humano.</small>
                </label>
                <label class="campo">
                  <span>Tamanho da resposta (caracteres)</span>
                  <input type="number" [min]="faixas.maxCaracteres.min" [max]="faixas.maxCaracteres.max"
                         [value]="f().regras.maxCaracteres" (input)="mudarRegra('maxCaracteres', +$any($event.target).value)"
                         [attr.aria-invalid]="erroDe('maxCaracteres') ? 'true' : null" />
                  @if (erroDe('maxCaracteres'); as e) { <span class="msg-erro">{{ e }}</span> }
                  <small>Parágrafo longo não é lido no celular.</small>
                </label>
                <label class="campo">
                  <span>Falas de contexto</span>
                  <input type="number" [min]="faixas.falasDeContexto.min" [max]="faixas.falasDeContexto.max"
                         [value]="f().regras.falasDeContexto" (input)="mudarRegra('falasDeContexto', +$any($event.target).value)"
                         [attr.aria-invalid]="erroDe('falasDeContexto') ? 'true' : null" />
                  @if (erroDe('falasDeContexto'); as e) { <span class="msg-erro">{{ e }}</span> }
                  <small>Quanto da conversa vai ao modelo. Mais falas, mais custo por turno.</small>
                </label>
              </div>

              <!-- ⚠️ Duas destas regras mudam QUEM fala com o cliente. Sem o aviso, o
                   dono liga a opção e descobre o efeito pelo cliente. -->
              @if (avisos().length > 0) {
                <div class="aviso">
                  <strong>O que muda com esta configuração</strong>
                  <ul>@for (a of avisos(); track a) { <li>{{ a }}</li> }</ul>
                </div>
              }
              @if (mudouDoPadrao()) {
                <div><ui-botao variante="fantasma" (click)="voltarAoPadrao()">Voltar ao padrão</ui-botao></div>
              }
            </ui-painel>

            <!-- (g) Avançado -->
            <ui-painel>
              <details class="avancado">
                <summary class="txt-secao">Avançado</summary>
                <div class="grade-2 topo">
                  <label class="campo">
                    <span>Limiar de confiança (0 a 1)</span>
                    <input type="number" step="0.05" [min]="faixasAvancado.limiarConfianca.min" [max]="faixasAvancado.limiarConfianca.max"
                           [value]="f().limiarConfianca" (input)="mudar('limiarConfianca', +$any($event.target).value)"
                           [attr.aria-invalid]="erroDe('limiarConfianca') ? 'true' : null" />
                    @if (erroDe('limiarConfianca'); as e) { <span class="msg-erro">{{ e }}</span> }
                    <small>Abaixo disto a resposta vira entrega ao humano por incerteza.</small>
                  </label>
                  <label class="campo">
                    <span>Máximo de rodadas de ferramenta por turno</span>
                    <input type="number" [min]="faixasAvancado.maxRodadas.min" [max]="faixasAvancado.maxRodadas.max"
                           [value]="f().maxRodadas" (input)="mudar('maxRodadas', +$any($event.target).value)"
                           [attr.aria-invalid]="erroDe('maxRodadas') ? 'true' : null" />
                    @if (erroDe('maxRodadas'); as e) { <span class="msg-erro">{{ e }}</span> }
                  </label>
                  <label class="campo">
                    <span>Prazo do turno (ms)</span>
                    <input type="number" step="1000" [min]="faixasAvancado.prazoTurnoMs.min" [max]="faixasAvancado.prazoTurnoMs.max"
                           [value]="f().prazoTurnoMs" (input)="mudar('prazoTurnoMs', +$any($event.target).value)"
                           [attr.aria-invalid]="erroDe('prazoTurnoMs') ? 'true' : null" />
                    @if (erroDe('prazoTurnoMs'); as e) { <span class="msg-erro">{{ e }}</span> }
                  </label>
                  <label class="campo">
                    <span>Orçamento por dia (R$)</span>
                    <input type="text" inputmode="decimal" [value]="f().orcamentoDiaTexto"
                           (input)="mudar('orcamentoDiaTexto', $any($event.target).value)"
                           [attr.aria-invalid]="erroDe('orcamentoDiaCentavos') ? 'true' : null" placeholder="Em branco não limita" />
                    @if (erroDe('orcamentoDiaCentavos'); as e) { <span class="msg-erro">{{ e }}</span> }
                    <small>Ao bater o teto, as conversas vão para a equipe — ele nunca cala.</small>
                  </label>
                </div>
              </details>
            </ui-painel>

            <div class="acoes">
              <ui-botao tipo="submit" [carregando]="salvando()">{{ salvando() ? 'Salvando…' : 'Salvar' }}</ui-botao>
              @if (temErros()) { <span class="msg-erro">Corrija os campos destacados.</span> }
            </div>
          </form>
        }
      }
    }
  `,
  styles: `
    :host { display: block; min-width: 0; }
    .form { display: grid; gap: var(--espacamento-4); min-width: 0; }
    .esq-lista { display: grid; gap: var(--espacamento-3); }
    .secao { margin: 0 0 var(--espacamento-3); color: var(--texto); }
    .sub { margin: var(--espacamento-4) 0 var(--espacamento-1); color: var(--texto); font-weight: 600; }
    .topo { margin-top: 0; }
    .dica { margin: var(--espacamento-1) 0 var(--espacamento-2); color: var(--texto-suave); font-size: 12px; }
    .modos, .objetivos { display: grid; gap: var(--espacamento-2); grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
    .modo { display: flex; align-items: flex-start; gap: var(--espacamento-2); padding: var(--espacamento-3);
      border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); cursor: pointer; min-width: 0;
      background: var(--superficie);
      transition: border-color var(--movimento-estado-duracao) var(--movimento-estado-curva); }
    .modo:hover { background: var(--superficie-hover); }
    .modo.sel { border-color: var(--acao); background: var(--superficie-selecionada); }
    .modo.off { opacity: .55; cursor: default; }
    .modo:has(input:focus-visible) { outline: 2px solid var(--borda-foco); outline-offset: 1px; }
    .modo input { margin-top: 3px; flex: none; }
    .modelos { display: grid; gap: var(--espacamento-2); min-width: 0; }
    .modelos[aria-invalid='true'] .card-modelo { border-color: var(--borda-erro); }
    .card-modelo .modo-txt { gap: var(--espacamento-1); }
    .linha-modelo { display: flex; align-items: center; gap: var(--espacamento-2); flex-wrap: wrap; min-width: 0; }
    .linha-modelo .modo-rot { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .meta-modelo { display: flex; align-items: center; gap: var(--espacamento-3); flex-wrap: wrap;
      color: var(--texto-secundario); font-size: 12px; }
    .obs { color: var(--texto-suave); font-size: 12px; overflow-wrap: anywhere; }
    .alerta { color: var(--atencao); }
    .grupo { margin: var(--espacamento-2) 0 0; }
    .vazio-modelos { margin: 0; }
    .topo-2 { margin-top: var(--espacamento-2); }
    .modo-txt { display: grid; gap: 2px; }
    .modo-rot { color: var(--texto); font-size: 13px; font-weight: 600; }
    .modo-exp { color: var(--texto-secundario); font-size: 12px; }
    .grade-2 { display: grid; gap: var(--espacamento-3); grid-template-columns: 1fr 1fr; min-width: 0; }
    .grade-3 { display: grid; gap: var(--espacamento-3); grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); margin-top: var(--espacamento-2); }
    .grade-2 > *, .grade-3 > * { min-width: 0; }
    .campo input, .campo select, .campo textarea { font: inherit; width: 100%; min-height: var(--densidade-alvo-clique-console); }
    .campo textarea { min-height: 0; }
    .campo input:focus-visible, .campo select:focus-visible, .campo textarea:focus-visible {
      outline: none; border-color: var(--borda-foco); box-shadow: 0 0 0 2px var(--borda-foco); }
    .campo [aria-invalid='true'] { border-color: var(--borda-erro); }
    .msg-erro { font-size: 12px; color: var(--erro); }
    .chk { display: flex; align-items: flex-start; gap: var(--espacamento-2); color: var(--texto); font-size: 14px;
      margin-top: var(--espacamento-2); }
    .chk input { margin-top: 3px; flex: none; }
    .slots { display: grid; gap: 0 var(--espacamento-4); grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); }
    .aviso { padding: var(--espacamento-2) var(--espacamento-3); border-radius: var(--raio-controle);
      background: var(--atencao-suave); color: var(--texto); font-size: 13px; margin-bottom: var(--espacamento-3); }
    .aviso--erro { background: var(--erro-suave); }
    .aviso ul { margin: var(--espacamento-1) 0 0; padding-left: var(--espacamento-4); display: grid; gap: 2px; }
    .aviso a { color: var(--acao); }
    .busca-estado { margin: var(--espacamento-2) 0 0; }
    .link { border: 0; background: transparent; padding: 0; font: inherit; color: var(--acao); cursor: pointer; text-decoration: underline; }
    .link:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; border-radius: var(--raio-controle); }
    .avancado summary { cursor: pointer; color: var(--texto); }
    .avancado[open] summary { margin-bottom: var(--espacamento-3); }
    .acoes { display: flex; align-items: center; gap: var(--espacamento-3); flex-wrap: wrap; }
    @media (max-width: 640px) { .grade-2 { grid-template-columns: 1fr; } }
  `,
})
export class AgenteConfigComponente {
  readonly canalId = input.required<string>()
  /** A página troca para a aba Conhecimento. */
  readonly abrirConhecimento = output<void>()

  private readonly api = inject(AgenteServico)
  private readonly conhecimento = inject(ConhecimentoServico)
  private readonly toast = inject(ToastServico)

  readonly modos = MODOS_AGENTE
  readonly rotuloModo = ROTULO_MODO
  readonly explicacao = EXPLICACAO_MODO
  readonly objetivos = OBJETIVOS_AGENTE
  readonly rotuloObjetivo = ROTULO_OBJETIVO
  readonly tons = TONS
  readonly rotuloTom = ROTULO_TOM
  readonly slots = SLOTS_QUALIFICACAO
  readonly rotuloSlot = ROTULO_SLOT
  readonly faixas = FAIXAS_REGRAS_AGENTE
  readonly faixasAvancado = FAIXAS_AVANCADO

  readonly estado = signal<Estado>('carregando')
  readonly cfg = signal<ConfigAgente | null>(null)
  /** ⚠️ Um signal com o formulário inteiro: os campos são salvos e validados JUNTOS. */
  readonly f = signal<FormularioAgente>(formularioDe(null))
  readonly salvando = signal(false)
  /** Só mostra erro local depois da primeira tentativa — antes disso é ruído. */
  private readonly tentou = signal(false)
  private readonly errosServidor = signal<Readonly<Record<string, string>>>({})
  readonly erroGeral = signal<string | null>(null)

  private readonly errosLocais = computed(() => (this.tentou() ? validarFormulario(this.f()) : {}))
  readonly temErros = computed(() => Object.keys(this.errosLocais()).length > 0 || Object.keys(this.errosServidor()).length > 0)
  readonly avisos = computed(() => avisosDasRegras(this.f().regras))
  readonly mudouDoPadrao = computed(() => mudouDoPadrao(this.f().regras, this.cfg()?.padroes ?? REGRAS_AGENTE_PADRAO))

  // ─── Seletor de modelo (catálogo do tenant; o staff libera, a chave é do servidor) ───
  readonly padraoDoServidor = MODELO_PADRAO_DO_SERVIDOR
  readonly estadoModelos = signal<EstadoModelos>('carregando')
  readonly catalogo = signal<CatalogoDoTenant | null>(null)
  readonly opcaoPadrao = computed(() => { const c = this.catalogo(); return c ? opcaoPadraoDoServidor(c) : null })
  readonly grupos = computed(() => {
    const g = agruparPorPreco(this.catalogo()?.itens ?? [])
    return [{ titulo: 'Gratuitos', itens: g.gratuitos }, { titulo: 'Pagos', itens: g.pagos }]
  })
  /** Os títulos de grupo só ajudam quando há os dois grupos. */
  readonly mostraTitulos = computed(() => this.grupos().every((g) => g.itens.length > 0))
  readonly foraDaLista = computed(() => escolhaForaDaLista(this.f().modelo, this.catalogo()?.itens ?? []))
  /** Frase do estado da busca da base de conhecimento; `null` enquanto não carregou ou se falhou. */
  readonly buscaConhecimento = signal<string | null>(null)

  constructor() {
    // Trocar de número recarrega; `untracked` para a carga não virar dependência.
    effect(() => { this.canalId(); untracked(() => void this.carregar()) })
    // O catálogo é do tenant, não do número: uma carga por tela.
    void this.carregarModelos()
    void this.carregarBuscaConhecimento()
  }

  /** Uma linha sob as políticas dizendo se a base busca só por palavras ou também por sentido. Falhou? Não aparece. */
  private async carregarBuscaConhecimento(): Promise<void> {
    try {
      this.buscaConhecimento.set(fraseCapacidade(await this.conhecimento.capacidades()))
    } catch { /* silencioso: é informativo, a aba Conhecimento tem o estado completo */ }
  }

  erroDe(campo: string): string | null {
    return this.errosServidor()[campo] ?? this.errosLocais()[campo] ?? null
  }

  provedor(p: string): string { return rotuloProvedor(p) }
  custo(m: ModeloIa): string | null { return linhaDeCusto(m) }
  pode(m: ModeloIa): boolean { return podeEscolher(m) }

  escolherModelo(codigo: string): void { this.mudar('modelo', codigo) }

  async carregarModelos(): Promise<void> {
    this.estadoModelos.set('carregando')
    try {
      this.catalogo.set(await this.api.listarModelos())
      this.estadoModelos.set('pronto')
    } catch {
      // ⚠️ Parcial: o formulário segue de pé; só o seletor mostra erro com "tentar de novo".
      this.estadoModelos.set('erro')
    }
  }

  bloqueiaModo(m: ModoAgente): boolean {
    return m !== 'desligado' && (this.cfg()?.faltaConfigurar.length ?? 0) > 0
  }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    this.tentou.set(false); this.errosServidor.set({}); this.erroGeral.set(null)
    try {
      const c = await this.api.carregarConfig(this.canalId())
      this.cfg.set(c)
      this.f.set(formularioDe(c))
      this.estado.set('pronto')
    } catch (e) {
      this.estado.set(ehSemPermissao(e) ? 'sem_permissao' : 'erro')
    }
  }

  mudar<K extends keyof FormularioAgente>(campo: K, valor: FormularioAgente[K]): void {
    this.f.update((a) => ({ ...a, [campo]: valor }))
    this.limparErro(campo === 'orcamentoDiaTexto' ? 'orcamentoDiaCentavos' : campo)
  }
  mudarModo(m: ModoAgente): void { this.mudar('modo', m) }
  mudarPersona<K extends keyof FormularioAgente['persona']>(campo: K, valor: FormularioAgente['persona'][K]): void {
    this.f.update((a) => ({ ...a, persona: { ...a.persona, [campo]: valor } }))
    this.limparErro(`persona.${campo}`)
  }
  mudarAlcada<K extends keyof FormularioAgente['alcada']>(campo: K, valor: FormularioAgente['alcada'][K]): void {
    this.f.update((a) => ({ ...a, alcada: { ...a.alcada, [campo]: valor } }))
    this.limparErro(campo === 'valorMaxTexto' ? 'alcada.valorMaxAutonomoCentavos' : `alcada.${campo}`)
  }
  mudarRegra<K extends keyof RegrasDoAgente>(campo: K, valor: RegrasDoAgente[K]): void {
    this.f.update((a) => ({ ...a, regras: { ...a.regras, [campo]: valor } }))
    this.limparErro(campo)
  }
  alternarSlot(slot: string, ligado: boolean): void {
    this.f.update((a) => ({
      ...a,
      qualificacao: ligado ? [...new Set([...a.qualificacao, slot])] : a.qualificacao.filter((s) => s !== slot),
    }))
  }
  voltarAoPadrao(): void {
    this.f.update((a) => ({ ...a, regras: this.cfg()?.padroes ?? REGRAS_AGENTE_PADRAO }))
  }

  private limparErro(campo: string): void {
    if (!(campo in this.errosServidor())) return
    this.errosServidor.update((e) => { const n = { ...e }; delete n[campo]; return n })
  }

  async salvar(ev: Event): Promise<void> {
    ev.preventDefault()
    if (this.salvando()) return
    this.tentou.set(true); this.errosServidor.set({}); this.erroGeral.set(null)
    if (Object.keys(validarFormulario(this.f())).length > 0) {
      this.toast.erro('Corrija os campos destacados antes de salvar.')
      return
    }
    this.salvando.set(true)
    try {
      const r = await this.api.salvarConfig(this.canalId(), corpoParaSalvar(this.f()))
      if (r.ok) {
        this.toast.sucesso(`Salvo — agente ${badgeModo(r.modo).rotulo.toLowerCase()} neste número.`)
        await this.carregar()
        return
      }
      if (r.status === 403) { this.estado.set('sem_permissao'); return }
      if (r.status === 404) { this.erroGeral.set('Este número não existe mais. Recarregue a lista de números.'); return }
      const mapeado = errosDoServidor(r.erro)
      this.errosServidor.set(mapeado.campos)
      this.erroGeral.set(mapeado.geral)
      this.toast.erro(mapeado.geral ?? 'Não foi possível salvar — veja os campos destacados.')
    } finally { this.salvando.set(false) }
  }
}

/** Do que a API devolve para o que a tela edita (reais como texto, regras completas). */
function formularioDe(c: ConfigAgente | null): FormularioAgente {
  return {
    modo: c?.modo ?? 'desligado',
    politicas: c?.politicas ?? '',
    persona: {
      nome: c?.persona.nome ?? 'Assistente',
      loja: c?.persona.loja ?? '',
      tom: c?.persona.tom ?? 'neutro',
      usaEmojis: c?.persona.usaEmojis ?? false,
      saudacao: c?.persona.saudacao ?? '',
      identificaComoRobo: c?.persona.identificaComoRobo ?? true,
    },
    objetivo: c?.objetivo ?? 'vender',
    qualificacao: c?.qualificacao ?? [],
    alcada: {
      valorMaxTexto: centavosParaTexto(c?.alcada.valorMaxAutonomoCentavos ?? 0),
      descontoMaxPct: c?.alcada.descontoMaxPct ?? 0,
      efetivaSozinho: c?.alcada.efetivaSozinho ?? false,
    },
    regras: c?.regras ?? REGRAS_AGENTE_PADRAO,
    modelo: c?.modelo ?? '',
    limiarConfianca: c?.limiarConfianca ?? 0.6,
    maxRodadas: c?.maxRodadas ?? 6,
    prazoTurnoMs: c?.prazoTurnoMs ?? 20000,
    orcamentoDiaTexto: c?.orcamentoDiaCentavos === null || c?.orcamentoDiaCentavos === undefined ? '' : centavosParaTexto(c.orcamentoDiaCentavos),
  }
}
