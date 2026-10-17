import { Component, ChangeDetectionStrategy, computed, effect, inject, input, output, signal, untracked } from '@angular/core'
import { RouterLink } from '@angular/router'
import {
  MODOS_AGENTE, ROTULO_MODO, OBJETIVOS_AGENTE, TONS, SLOTS_QUALIFICACAO, REGRAS_AGENTE_PADRAO,
  avisosDasRegras, type ModoAgente, type RegrasDoAgente, type SegmentoRecorte,
} from '@geracrm/shared'
import {
  BotaoComponente, CampoComponente, PainelComponente, EsqueletoComponente, EstadoComponente, BadgeComponente,
  QualidadeComponente, ToastServico, ConfirmacaoServico, HorarioAtendimentoComponente,
  agruparPorPreco, linhaDeCusto, rotuloProvedor, type HorarioAtendimento, type ModeloIa,
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
import { ModoServico } from './modo.servico.js'
import {
  MODOS_FORA, ROTULO_FORA, ROTULO_SEGMENTO, SEGMENTOS, erroDoRecorte, fraseOrigem, fraseReserva, pedidoDeConfirmacao,
  recorteParaFormulario, recorteParaSalvar, type FormularioRecorte, type ModoNaConfig, type TetoDoTenant,
} from './modo.regras.js'
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
    BadgeComponente, QualidadeComponente, HorarioAtendimentoComponente,
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

            @if (podeConfigurar() === false) {
              <div class="aviso" role="status">Só um <strong>administrador</strong> muda a configuração do agente. Você está vendo em modo leitura.</div>
            }

            <!-- (a) Modo — o selo mostra o modo EFETIVO agora e de onde veio a restrição (ADR-028). -->
            <ui-painel>
              <h2 class="txt-secao secao">Modo</h2>
              @if (modoEfetivo(); as e) {
                <div class="selo" role="status" aria-live="polite">
                  <span class="txt-rotulo">Agora</span>
                  <ui-badge [tom]="badge(e.modo).tom">{{ badge(e.modo).rotulo }}</ui-badge>
                  @if (e.origem !== 'numero') { <ui-badge tom="atencao">{{ e.origem === 'tenant' ? 'teto da conta' : 'fora do recorte' }}</ui-badge> }
                  <span class="selo-frase encolhe">{{ frase(e) }}</span>
                </div>
              }
              <p class="dica topo">Comece em sombra, passe para assistido e só então deixe autônomo — por número. Autônomo e desligado pedem que você digite o nome do modo para confirmar.</p>
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

            <!-- (a1) Recorte — onde o modo do número vale; fora dele CAI, nunca sobe. -->
            <ui-painel>
              <h2 class="txt-secao secao">Recorte</h2>
              <p class="dica topo">Limite o modo deste número a um horário e a segmentos de cliente. Fora do recorte o agente cai para o modo escolhido abaixo — nunca sobe.</p>
              @if (cfgModo()?.recorteInvalido) {
                <div class="aviso" role="alert">O recorte salvo está inválido e o agente atua em sombra por segurança. Ajuste abaixo e salve.</div>
              }
              <label class="chk">
                <input type="checkbox" [checked]="rf().ativo" (change)="mudarRecorte('ativo', $any($event.target).checked)" />
                Usar recorte neste número
              </label>
              @if (rf().ativo) {
                <div class="recorte">
                  <label class="chk">
                    <input type="checkbox" [checked]="rf().usaHorario" (change)="mudarRecorte('usaHorario', $any($event.target).checked)" />
                    Só em um horário
                  </label>
                  @if (rf().usaHorario) {
                    <ui-horario-atendimento legenda="Horário do recorte (fuso da loja)" [horario]="rf().horario" (horarioChange)="mudarHorarioRecorte($event)" />
                  }
                  <fieldset class="segmentos">
                    <legend class="txt-rotulo">Segmentos de cliente (RFV) — nenhum marcado = todos</legend>
                    <div class="slots">
                      @for (sg of segmentos; track sg) {
                        <label class="chk">
                          <input type="checkbox" [checked]="rf().segmentos.includes(sg)" (change)="alternarSegmento(sg, $any($event.target).checked)" />
                          {{ rotuloSegmento[sg] }}
                        </label>
                      }
                    </div>
                  </fieldset>
                  <fieldset class="segmentos">
                    <legend class="txt-rotulo">Fora do recorte</legend>
                    <div class="fora" role="radiogroup" aria-label="Modo fora do recorte">
                      @for (m of modosFora; track m) {
                        <label class="chk">
                          <input type="radio" name="foraDoRecorte" [value]="m" [checked]="rf().foraDoRecorte === m" (change)="mudarRecorte('foraDoRecorte', m)" />
                          {{ rotuloFora[m] }}
                        </label>
                      }
                    </div>
                  </fieldset>
                  @if (erroRecorte(); as e) { <span class="msg-erro" role="alert">{{ e }}</span> }
                  @if (erroDe('recorte'); as e) { <span class="msg-erro" role="alert">{{ e }}</span> }
                </div>
              }
            </ui-painel>

            <!-- (a1b) Teto da conta — o kill switch geral (vale para todos os números). -->
            <ui-painel>
              <h2 class="txt-secao secao">Teto da conta</h2>
              <p class="dica topo">O modo mais solto que <strong>qualquer</strong> número pode ter. “Desligado” cala o agente em todos os números de uma vez, sem mexer na configuração de cada um — as mensagens continuam gravadas.</p>
              @switch (estadoTeto()) {
                @case ('carregando') { <ui-esqueleto altura="40px" largura="60%" /> }
                @case ('erro') {
                  <div class="aviso aviso--erro" role="alert">Não foi possível ler o teto da conta.
                    <div class="topo-2"><ui-botao variante="secundario" (click)="carregarTeto()">Tentar de novo</ui-botao></div></div>
                }
                @case ('pronto') {
                  @if (teto(); as t) {
                    <div class="teto">
                      <label class="campo teto-campo">
                        <span>Modo máximo da conta</span>
                        <select [value]="tetoEscolhido()" [disabled]="!t.podeConfigurar || salvandoTeto()"
                                (change)="tetoEscolhido.set($any($event.target).value)">
                          @for (m of modos; track m) { <option [value]="m" [selected]="tetoEscolhido() === m">{{ badge(m).rotulo }}</option> }
                        </select>
                      </label>
                      @if (t.podeConfigurar) {
                        <ui-botao variante="secundario" [carregando]="salvandoTeto()" [desabilitado]="tetoEscolhido() === t.modoMaximo"
                                  (click)="aplicarTeto()">Aplicar a todos os números</ui-botao>
                      }
                    </div>
                    @if (t.atualizadoEm) {
                      <p class="dica">Alterado {{ t.atualizadoPor ? 'por ' + t.atualizadoPor + ' ' : '' }}em <span class="txt-dados">{{ dataHora(t.atualizadoEm) }}</span>.</p>
                    }
                  }
                }
              }
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
                    @if (reserva(); as r) {
                      <p class="reserva"><ui-badge [tom]="r.tom">reserva</ui-badge> <span class="encolhe">{{ r.texto }}</span></p>
                    }
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
              <!-- Sem opção de desligar (ADR-028/029): identificar-se é regra, não preferência. -->
              <p class="dica">O agente <strong>sempre</strong> se apresenta como assistente virtual da loja — é regra (exigência da Meta e do produto), não uma opção.</p>
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
              <ui-botao tipo="submit" [carregando]="salvando()" [desabilitado]="podeConfigurar() === false">{{ salvando() ? 'Salvando…' : 'Salvar' }}</ui-botao>
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
    .selo { display: flex; align-items: center; gap: var(--espacamento-2); flex-wrap: wrap; min-width: 0;
      padding: var(--espacamento-2) var(--espacamento-3); margin-bottom: var(--espacamento-3);
      border: 1px solid var(--borda); border-radius: var(--raio-controle); background: var(--fundo); }
    .selo-frase { color: var(--texto-secundario); font-size: 13px; flex: 1 1 260px; }
    .recorte { display: grid; gap: var(--espacamento-3); margin-top: var(--espacamento-2); min-width: 0; }
    .segmentos { border: 1px solid var(--borda); border-radius: var(--raio-painel); margin: 0;
      padding: var(--espacamento-2) var(--espacamento-4) var(--espacamento-3); min-width: 0; }
    .segmentos legend { padding: 0 var(--espacamento-1); }
    .fora { display: grid; gap: 0; }
    .teto { display: flex; align-items: end; gap: var(--espacamento-3); flex-wrap: wrap; }
    .teto-campo { display: grid; gap: var(--espacamento-1); min-width: 220px; }
    .reserva { display: flex; align-items: center; gap: var(--espacamento-2); flex-wrap: wrap; margin: var(--espacamento-2) 0 0;
      color: var(--texto-secundario); font-size: 12px; }
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
  private readonly modoApi = inject(ModoServico)
  private readonly confirmacao = inject(ConfirmacaoServico)

  // ─── Modo efetivo, recorte e teto da conta (ADR-028, P14) ───
  readonly segmentos = SEGMENTOS
  readonly rotuloSegmento = ROTULO_SEGMENTO
  readonly modosFora = MODOS_FORA
  readonly rotuloFora = ROTULO_FORA
  /** O GET com os campos do modo (opcionais: a API anterior não manda). */
  readonly cfgModo = computed(() => this.cfg() as (ConfigAgente & ModoNaConfig) | null)
  readonly modoEfetivo = computed(() => this.cfgModo()?.modoEfetivo ?? null)
  /** `undefined` = API anterior (não sabe) — trata como pode. */
  readonly podeConfigurar = computed(() => this.cfgModo()?.podeConfigurar)
  readonly reserva = computed(() => fraseReserva(this.cfgModo()?.reservaLlm))
  readonly rf = signal<FormularioRecorte>(recorteParaFormulario(null))
  readonly erroRecorte = computed(() => (this.tentou() ? erroDoRecorte(this.rf()) : null))
  readonly estadoTeto = signal<'carregando' | 'pronto' | 'erro'>('carregando')
  readonly teto = signal<TetoDoTenant | null>(null)
  readonly tetoEscolhido = signal<ModoAgente>('autonomo')
  readonly salvandoTeto = signal(false)

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
    void this.carregarTeto()
  }

  badge(m: string): { rotulo: string; tom: 'neutro' | 'sucesso' | 'atencao' | 'erro' | 'info' } { return badgeModo(m) }
  frase(e: NonNullable<ModoNaConfig['modoEfetivo']>): string { return fraseOrigem(e, this.cfg()?.modo ?? 'desligado') }
  dataHora(iso: string): string { return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) }

  mudarRecorte<K extends 'ativo' | 'usaHorario' | 'foraDoRecorte'>(campo: K, valor: FormularioRecorte[K]): void {
    this.rf.update((r) => ({ ...r, [campo]: valor }))
    this.limparErro('recorte')
  }
  mudarHorarioRecorte(h: HorarioAtendimento): void { this.rf.update((r) => ({ ...r, horario: h })); this.limparErro('recorte') }
  alternarSegmento(sg: SegmentoRecorte, ligado: boolean): void {
    this.rf.update((r) => ({ ...r, segmentos: ligado ? [...new Set([...r.segmentos, sg])] : r.segmentos.filter((x) => x !== sg) }))
    this.limparErro('recorte')
  }

  async carregarTeto(): Promise<void> {
    this.estadoTeto.set('carregando')
    try {
      const t = await this.modoApi.carregarTeto()
      this.teto.set(t); this.tetoEscolhido.set(t.modoMaximo)
      this.estadoTeto.set('pronto')
    } catch {
      // Parcial: o formulário do número segue de pé; só o painel do teto mostra o erro.
      this.estadoTeto.set('erro')
    }
  }

  async aplicarTeto(): Promise<void> {
    const t = this.teto()
    if (!t || this.salvandoTeto()) return
    const novo = this.tetoEscolhido()
    const pedido = pedidoDeConfirmacao(t.modoMaximo, novo, 'conta')
    if (pedido && !(await this.confirmacao.confirmar({ ...pedido, perigo: true }))) { this.tetoEscolhido.set(t.modoMaximo); return }
    this.salvandoTeto.set(true)
    try {
      const r = await this.modoApi.salvarTeto(novo, pedido ? this.confirmacao.digitado() : null)
      if (!r.ok) {
        this.toast.erro(r.status === 403 ? 'Só um administrador muda o teto da conta.' : (r.erro.mensagem ?? 'Não foi possível aplicar o teto.'))
        this.tetoEscolhido.set(t.modoMaximo)
        return
      }
      this.toast.sucesso(`Teto da conta: ${badgeModo(novo).rotulo.toLowerCase()} — vale para todos os números.`)
      await Promise.all([this.carregarTeto(), this.carregar()])
    } finally { this.salvandoTeto.set(false) }
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
      this.rf.set(recorteParaFormulario((c as ConfigAgente & ModoNaConfig).recorte ?? null))
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
    if (Object.keys(validarFormulario(this.f())).length > 0 || erroDoRecorte(this.rf()) !== null) {
      this.toast.erro('Corrija os campos destacados antes de salvar.')
      return
    }
    // ⚠️ Autônomo e desligado pedem o nome do modo DIGITADO (ADR-028). A API
    //    confere de novo — a tela só evita a ida e volta.
    const pedido = pedidoDeConfirmacao(this.cfg()?.modo ?? null, this.f().modo, 'numero')
    if (pedido && !(await this.confirmacao.confirmar({ ...pedido, perigo: true }))) return
    this.salvando.set(true)
    try {
      const corpo = {
        ...corpoParaSalvar(this.f()),
        recorte: recorteParaSalvar(this.rf()),
        ...(pedido ? { confirmacao: this.confirmacao.digitado() } : {}),
      }
      const r = await this.api.salvarConfig(this.canalId(), corpo)
      if (r.ok) {
        this.toast.sucesso(`Salvo — agente ${badgeModo(r.modo).rotulo.toLowerCase()} neste número.`)
        await this.carregar()
        return
      }
      if (r.status === 403) { this.estado.set('sem_permissao'); return }
      if (r.status === 404) { this.erroGeral.set('Este número não existe mais. Recarregue a lista de números.'); return }
      if (r.erro.erro === 'agente.confirmacao_necessaria') { this.erroGeral.set(r.erro.mensagem ?? 'Confirme a troca de modo digitando o nome do modo.'); return }
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
