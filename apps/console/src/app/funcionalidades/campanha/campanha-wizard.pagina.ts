import { ChangeDetectionStrategy, Component, OnInit, computed, effect, inject, input, signal } from '@angular/core'
import { FormControl, ReactiveFormsModule } from '@angular/forms'
import { Router } from '@angular/router'
import {
  CODIGOS_SEGMENTO_RFV, MOTIVOS_EXCLUSAO, QUALIFICACOES_CONTATO, ROTULO_MOTIVO_EXCLUSAO, ROTULO_QUALIFICACAO, rotuloSegmento,
} from '@geracrm/shared'
import {
  BreadcrumbComponente, CabecalhoTelaComponente, CampoComponente, ChipsEtiquetaComponente, EsqueletoComponente,
  EstadoComponente, HorarioAtendimentoComponente, IconeComponente, ListaDefinicaoComponente, SelectComponente, SelectMultiComponente,
  SelectPaginadoComponente, StatCardComponente, ToastServico, corpoDoErro, ehStatus, mensagemDeErro,
  type CarregarOpcoes, type ItemDefinicao, type ItemTrilha, type OpcaoChip, type OpcaoPaginada, type OpcaoSelect, type PaginaOpcoes,
} from '../../compartilhado/ui/index.js'
import { EtiquetasServico } from '../crm/etiquetas.servico.js'
import {
  FORM_VAZIO, PASSOS, ROTULO_ORIGEM_JANELA, ROTULO_PASSO, TIPO_NAO_OFICIAL, TIPO_OFICIAL, errosDoPasso, excluidosOrdenados,
  formDaCampanha, formatarCusto, loteEfetivo, mapearErro, montarCorpo, montarCorpoPrevia, passosComErro, resumoJanela, resumoPublico,
  textoAquecimento, textoDuracao, textoPrecoUnitario, textoVariaveisFaltando, variaveisSemMapeamento,
  type ErrosCampo, type FormCampanha, type OpcaoEscolhida, type PassoWizard, type PreviaApi, type PublicoForm,
} from './campanhas.regras.js'
import { CampanhasServico, type CanalCampanha, type CampanhaDetalhe, type EtapaFunil, type TemplateCampanha } from './campanhas.servico.js'

type Estado = 'carregando' | 'pronto' | 'erro' | 'sem_permissao' | 'nao_editavel'
type EstadoPrevia = 'ocioso' | 'carregando' | 'pronto' | 'erro'

const ATRASO_PREVIA_MS = 600
const MAX_PAGINAS_ROTULO = 5

const OPCOES_SEGMENTO: OpcaoChip[] = CODIGOS_SEGMENTO_RFV.map((c) => ({ valor: c, rotulo: rotuloSegmento(c) }))
const OPCOES_QUALIFICACAO: OpcaoChip[] = QUALIFICACOES_CONTATO.map((q) => ({ valor: q, rotulo: ROTULO_QUALIFICACAO[q] }))

/**
 * Wizard da campanha v2 (F1b, padrão F): Detalhes e template · Público · Envio · Revisão.
 *
 * ⚠️ A API é a regra: a tela antecipa o erro (`errosDoPasso`) e o 422 volta por campo (`mapearErro`), levando
 * a pessoa ao passo certo. Preço, elegibilidade e janela do número vêm da prévia do servidor — o corpo nunca
 * carrega custo. No número NÃO oficial o risco de banimento (ADR-021) fica visível e a confirmação é obrigatória.
 * Salvar cria/atualiza o RASCUNHO; testar e iniciar acontecem no detalhe.
 */
@Component({
  selector: 'app-campanha-wizard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule, BreadcrumbComponente, CabecalhoTelaComponente, CampoComponente, ChipsEtiquetaComponente,
    EsqueletoComponente, EstadoComponente, HorarioAtendimentoComponente, IconeComponente, ListaDefinicaoComponente, SelectComponente, SelectMultiComponente,
    SelectPaginadoComponente, StatCardComponente, SelectMultiComponente,
  ],
  template: `
    <ui-cabecalho-tela [titulo]="editando() ? 'Editar campanha' : 'Nova campanha'"
      subtitulo="Escolha o número e a mensagem, defina quem recebe e confira o custo antes de salvar.">
      <ui-breadcrumb trilha [itens]="trilha()" />
    </ui-cabecalho-tela>

    @switch (estado()) {
      @case ('carregando') {
        <div class="esqueleto" aria-busy="true" aria-label="Carregando">
          @for (i of [1, 2, 3]; track i) { <ui-esqueleto altura="56px" /> }
        </div>
      }
      @case ('sem_permissao') {
        <ui-estado tipo="sem-permissao" titulo="Sem acesso a campanhas" descricao="Criar e editar campanhas é com administradores e gestores." />
      }
      @case ('nao_editavel') {
        <ui-estado titulo="Esta campanha não pode mais ser editada" descricao="Só rascunhos da versão nova são editáveis. Veja o andamento no detalhe.">
          <button type="button" class="btn btn--secundario" (click)="voltarAoDetalhe()">Ver campanha</button>
        </ui-estado>
      }
      @case ('erro') {
        <ui-estado tipo="erro" titulo="Não foi possível abrir o formulário" [descricao]="erroCarga()">
          <button type="button" class="btn btn--secundario" (click)="carregar()">Tentar de novo</button>
        </ui-estado>
      }
      @default {
        @if (canaisWhatsapp().length === 0) {
          <ui-estado titulo="Nenhum número de WhatsApp conectado"
            descricao="Campanha sai por um número de WhatsApp. Conecte um número na tela Números e volte aqui.">
            <button type="button" class="btn btn--secundario" (click)="irParaNumeros()">Ir para Números</button>
          </ui-estado>
        } @else {
          <nav aria-label="Passos da campanha">
            <ol class="passos">
              @for (p of passos; track p; let i = $index) {
                <li class="passo" [class.passo--ativo]="p === passo()" [class.passo--feito]="i < indicePasso()">
                  <button type="button" class="passo-btn" [attr.aria-current]="p === passo() ? 'step' : null"
                    [disabled]="i > alcancado()" (click)="irPara(p)">
                    <span class="passo-num" aria-hidden="true">{{ i + 1 }}</span>
                    <span class="passo-nome">{{ rotuloPasso(p) }}</span>
                  </button>
                </li>
              }
            </ol>
          </nav>

          @if (erroGeral(); as g) { <p class="erro-geral" role="alert">{{ g }}</p> }

          <div class="layout" [class.layout--sem-previa]="passo() === 'detalhes'">
            <section class="cartao" [attr.aria-label]="rotuloPasso(passo())">
              @switch (passo()) {
                @case ('detalhes') {
                  <h2 class="txt-secao">Detalhes e template</h2>
                  <div class="grade">
                    <ui-campo [obrigatorio]="true" rotulo="Nome da campanha" [valor]="form().nome" (valorChange)="atualizar({ nome: $event })"
                      [erro]="erro('nome')" dica="Você vai digitar este nome para iniciar, então escolha um que seja fácil de conferir." />
                    <ui-select [obrigatorio]="true" rotulo="Número que envia" placeholder="Escolha o número" [opcoes]="opcoesCanal()"
                      [valor]="form().canalId" (valorChange)="escolherCanal($event)" [erro]="erro('canalId')" />
                  </div>

                  @if (ehOficial()) {
                    <div class="bloco">
                      <ui-select-paginado [obrigatorio]="true" rotulo="Template aprovado" placeholder="Escolha o template"
                        [carregar]="carregarTemplates" [opcaoInjetada]="templateInjetado()" [formControl]="templateCtl"
                        [erro]="erro('templateId')"
                        dica="No número oficial a campanha sai por template de marketing aprovado pela Meta. Só aparecem os aprovados." />
                      @if (variaveisFaltando().length > 0) {
                        <p class="aviso aviso--atencao" role="alert">
                          <ui-icone nome="alert-triangle" [tamanho]="14" /> {{ textoFaltando() }}
                        </p>
                      }
                      @if (templateSel(); as t) {
                        @if (t.texto) {
                          <div class="previa-msg" aria-label="Corpo do template">
                            <span class="txt-rotulo">Mensagem</span>
                            <p>{{ t.texto }}</p>
                          </div>
                        }
                      }
                    </div>
                  }

                  @if (ehNaoOficial()) {
                    <div class="bloco">
                      <div class="aviso aviso--risco" role="note">
                        <ui-icone nome="alert-triangle" />
                        <div>
                          <strong>Risco de banimento.</strong>
                          <p>Este é um número não oficial: o disparo em massa pode levar o WhatsApp a banir o número, e o banimento
                            não tem volta. O envio respeita o aquecimento do número, mas o risco continua sendo seu.</p>
                        </div>
                      </div>
                      <ui-campo tipo="textarea" [obrigatorio]="true" rotulo="Texto da campanha" [valor]="form().mensagem"
                        (valorChange)="atualizar({ mensagem: $event })" [erro]="erro('mensagem')" [largo]="true"
                        dica="Texto livre. Sem variáveis: a mesma mensagem vai para todos." />
                      <label class="confirma" [class.confirma--erro]="!!erro('confirmaRiscoBanimento')">
                        <input type="checkbox" [checked]="form().confirmaRiscoBanimento"
                          (change)="atualizar({ confirmaRiscoBanimento: $any($event.target).checked })"
                          [attr.aria-invalid]="!!erro('confirmaRiscoBanimento')" />
                        <span>Estou ciente do risco de banimento deste número e quero enviar mesmo assim.</span>
                      </label>
                      @if (erro('confirmaRiscoBanimento'); as m) { <p class="erro" role="alert">{{ m }}</p> }
                    </div>
                  }
                  @if (!ehOficial() && !ehNaoOficial() && form().canalId) {
                    <p class="erro" role="alert">{{ erro('canalId') }}</p>
                  }
                }

                @case ('publico') {
                  <h2 class="txt-secao">Público</h2>
                  <p class="txt-corpo ajuda">Cada tipo restringe o público (E entre tipos); dentro de um tipo, basta um (OU).
                    Tipo vazio não restringe. Sem nenhum filtro, vale a base inteira, menos as exclusões automáticas.</p>

                  <fieldset class="grupo">
                    <legend class="txt-rotulo">Segmento de recompra</legend>
                    <ui-chips-etiqueta [opcoes]="opcoesSegmento" [selecionadas]="mutavel(form().publico.segmentos)"
                      (selecionadasChange)="atualizarPublico({ segmentos: $event })" />
                  </fieldset>

                  <fieldset class="grupo">
                    <legend class="txt-rotulo">Qualificação</legend>
                    <ui-chips-etiqueta [opcoes]="opcoesQualificacao" [selecionadas]="mutavel(form().publico.qualificacao)"
                      (selecionadasChange)="atualizarPublico({ qualificacao: $event })" />
                  </fieldset>

                  @if (opcoesEtapa().length > 0) {
                    <fieldset class="grupo">
                      <legend class="txt-rotulo">Etapa do funil</legend>
                      <ui-chips-etiqueta [opcoes]="opcoesEtapa()" [selecionadas]="valoresDe(form().publico.etapas)"
                        (selecionadasChange)="escolherEtapas($event)" />
                    </fieldset>
                  }

                  <div class="grade">
                    <ui-select-multi rotulo="Listas" placeholder="Buscar lista" [carregar]="carregarListas"
                      [valor]="valoresDe(form().publico.listas)" [opcoesInjetadas]="form().publico.listas" (escolhidas)="atualizarPublico({ listas: $event })"
                      [erro]="erro('publico.listas')" />
                    <ui-select-multi rotulo="Etiquetas" placeholder="Buscar etiqueta" [carregar]="carregarEtiquetas"
                      [valor]="valoresDe(form().publico.etiquetas)" [opcoesInjetadas]="form().publico.etiquetas" (escolhidas)="atualizarPublico({ etiquetas: $event })"
                      [erro]="erro('publico.etiquetas')" />
                    <ui-select-multi rotulo="Origens" placeholder="Buscar origem" [carregar]="carregarOrigens"
                      [valor]="valoresDe(form().publico.origens)" [opcoesInjetadas]="form().publico.origens" (escolhidas)="atualizarPublico({ origens: $event })"
                      [erro]="erro('publico.origens')" />
                    <ui-campo tipo="number" rotulo="Sem interação há (dias)" [valor]="form().publico.semInteracaoDias"
                      (valorChange)="atualizarPublico({ semInteracaoDias: $event })" [erro]="erro('publico.semInteracaoDias')"
                      dica="Sem conversa nem contato há pelo menos N dias." />
                    <ui-campo tipo="date" rotulo="Criado a partir de" [valor]="form().publico.criadoDe"
                      (valorChange)="atualizarPublico({ criadoDe: $event })" [erro]="erro('publico.criadoDe')" />
                    <ui-campo tipo="date" rotulo="Criado até" [valor]="form().publico.criadoAte"
                      (valorChange)="atualizarPublico({ criadoAte: $event })" [erro]="erro('publico.criadoAte')" />
                  </div>

                  <fieldset class="grupo">
                    <legend class="txt-rotulo">Exclusões automáticas</legend>
                    <p class="txt-corpo ajuda">Ficam sempre de fora: quem pediu para não receber, contatos inativos, sem telefone e telefones
                      repetidos. Estes prazos você ajusta (em branco usa o padrão; 0 desliga).</p>
                    <div class="grade grade--3">
                      <ui-campo tipo="number" rotulo="Conversou há menos de (dias)" [valor]="form().publico.conversaRecenteDias"
                        (valorChange)="atualizarPublico({ conversaRecenteDias: $event })" placeholder="7"
                        [erro]="erro('publico.exclusoes.conversaRecenteDias')" />
                      <ui-campo tipo="number" rotulo="Recebeu campanha há menos de (dias)" [valor]="form().publico.campanhaRecenteDias"
                        (valorChange)="atualizarPublico({ campanhaRecenteDias: $event })" placeholder="30"
                        [erro]="erro('publico.exclusoes.campanhaRecenteDias')" />
                      <ui-campo tipo="number" rotulo="Comprou há menos de (dias)" [valor]="form().publico.compraRecenteDias"
                        (valorChange)="atualizarPublico({ compraRecenteDias: $event })" placeholder="7"
                        [erro]="erro('publico.exclusoes.compraRecenteDias')" />
                    </div>
                  </fieldset>
                }

                @case ('envio') {
                  <h2 class="txt-secao">Envio</h2>
                  <div class="grade">
                    <ui-campo tipo="number" rotulo="Lote diário (mensagens por dia)" [valor]="form().loteDiario"
                      (valorChange)="atualizar({ loteDiario: $event })" placeholder="500" [erro]="erro('loteDiario')"
                      dica="Em branco, usa 500 por dia. A campanha envia no máximo isto por dia, dentro da janela." />
                    <ui-campo tipo="datetime-local" rotulo="Início agendado" [valor]="form().inicioEm"
                      (valorChange)="atualizar({ inicioEm: $event })" [erro]="erro('inicioEm')"
                      dica="Em branco, começa assim que você iniciar." />
                    <ui-campo tipo="number" rotulo="Janela de resposta (dias)" [obrigatorio]="true" [valor]="form().janelaDias"
                      (valorChange)="atualizar({ janelaDias: $event })" [erro]="erro('janelaDias')"
                      dica="Compra do cliente até N dias depois do envio entra na conta de retorno (estimada). O pedido nascido da campanha é sempre contado à parte (exato)." />
                  </div>

                  <fieldset class="grupo">
                    <legend class="txt-rotulo">Janela de envio</legend>
                    <label class="confirma">
                      <input type="checkbox" [checked]="form().janelaPropria" (change)="atualizar({ janelaPropria: $any($event.target).checked })" />
                      <span>Definir uma janela só para esta campanha</span>
                    </label>
                    @if (form().janelaPropria) {
                      <ui-horario-atendimento legenda="Horário de envio por dia da semana" [horario]="form().janela"
                        (horarioChange)="atualizar({ janela: $event })" />
                      @if (erro('janela'); as m) { <p class="erro" role="alert">{{ m }}</p> }
                    } @else {
                      <p class="txt-corpo ajuda">
                        @if (previa(); as p) {
                          Vale a janela {{ rotuloOrigemJanela(p.janelaDoNumero.origem) }}: {{ resumoDaJanela(p) }}.
                        } @else {
                          Sem janela própria, vale o expediente do número; se ele não tiver, segunda a sábado, 8h às 20h.
                        }
                      </p>
                    }
                  </fieldset>
                }

                @case ('revisao') {
                  <h2 class="txt-secao">Revisão</h2>
                  <ui-lista-definicao [colunas]="2" [itens]="itensRevisao()" />
                  <fieldset class="grupo">
                    <legend class="txt-rotulo">Público</legend>
                    <ul class="resumo">
                      @for (l of linhasPublico(); track l) { <li>{{ l }}</li> }
                    </ul>
                  </fieldset>
                  <p class="txt-corpo ajuda">Salvar cria um rascunho: nada é enviado. No detalhe você manda um teste para até 5 números e,
                    quando estiver certo, inicia digitando o nome da campanha.</p>
                }
              }
            </section>

            @if (passo() !== 'detalhes') {
              <aside class="cartao previa" aria-label="Prévia do público e do custo" aria-live="polite">
                <h2 class="txt-secao">Prévia</h2>
                @switch (previaEstado()) {
                  @case ('carregando') { <p class="txt-corpo">Calculando…</p> }
                  @case ('erro') { <p class="erro" role="alert">{{ previaErro() }}</p> }
                  @case ('ocioso') { <p class="txt-corpo">Escolha o número para ver o público e o custo.</p> }
                }
                @if (previa(); as p) {
                  <div class="kpis" [class.kpis--velha]="previaEstado() === 'carregando'">
                    <ui-stat-card tom="acao" [valor]="p.elegiveis" [rotulo]="'elegíveis de ' + p.total" />
                    <ui-stat-card tom="neutro" [valor]="custo(p)" [rotulo]="textoPreco(p)" />
                    <ui-stat-card tom="neutro" [valor]="duracao(p)" [rotulo]="'lote de ' + p.loteDiario + ' por dia'" />
                  </div>
                  @if (aquecimento(p); as a) { <p class="aviso aviso--atencao">{{ a }}</p> }
                  @if (excluidos(p).length > 0) {
                    <h3 class="txt-rotulo">Ficam de fora</h3>
                    <ul class="excluidos">
                      @for (x of excluidos(p); track x.motivo) {
                        <li><span>{{ rotuloExclusao(x.motivo) }}</span><span class="txt-dados">{{ x.n }}</span></li>
                      }
                    </ul>
                  }
                  @if (p.amostra.length > 0) {
                    <h3 class="txt-rotulo">Amostra de quem recebe</h3>
                    <ul class="amostra">
                      @for (a of p.amostra; track $index) {
                        <li>{{ a.nome }}@if (a.cidade) { <span class="cidade"> · {{ a.cidade }}</span> }</li>
                      }
                    </ul>
                  } @else if (p.elegiveis === 0) {
                    <p class="aviso aviso--atencao">Nenhum contato elegível. Afrouxe o público ou as exclusões.</p>
                  }
                }
              </aside>
            }
          </div>

          <div class="rodape">
            @if (indicePasso() > 0) {
              <button type="button" class="btn btn--secundario" (click)="voltar()">Voltar</button>
            }
            <span class="espaco"></span>
            <button type="button" class="btn btn--secundario" (click)="cancelar()">Cancelar</button>
            @if (passo() === 'revisao') {
              <button type="button" class="btn btn--primario" [disabled]="salvando()" (click)="salvar()">
                {{ salvando() ? 'Salvando…' : 'Salvar rascunho' }}
              </button>
            } @else {
              <button type="button" class="btn btn--primario" (click)="avancar()">Avançar</button>
            }
          </div>
        }
      }
    }
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); container-type: inline-size; }
    .esqueleto { display: grid; gap: var(--espacamento-3); }
    .passos { display: flex; flex-wrap: wrap; gap: var(--espacamento-2); margin: 0 0 var(--espacamento-5); padding: 0; list-style: none; }
    .passo { flex: 1 1 160px; min-width: 0; }
    .passo-btn { display: flex; align-items: center; gap: var(--espacamento-2); width: 100%; min-height: var(--densidade-alvo-clique-console);
      padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda); border-radius: var(--raio-controle);
      background: var(--superficie-elevada); color: var(--texto-secundario); font: inherit; text-align: left; cursor: pointer; }
    .passo-btn:disabled { cursor: default; opacity: .6; }
    .passo-btn:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; }
    .passo-num { display: inline-grid; place-items: center; flex: none; width: 24px; height: 24px; border-radius: var(--raio-completo);
      border: 1px solid var(--borda-controle); font-size: 12px; font-weight: 600; }
    .passo-nome { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
    .passo--ativo .passo-btn { border-color: var(--acao); color: var(--texto); }
    .passo--ativo .passo-num { background: var(--acao); border-color: var(--acao); color: var(--acao-texto); }
    .passo--feito .passo-num { background: var(--sucesso-suave); border-color: var(--sucesso); color: var(--sucesso); }
    .layout { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: var(--espacamento-4); align-items: start; }
    .layout--sem-previa { grid-template-columns: minmax(0, 1fr); }
    @container (max-width: 980px) { .layout { grid-template-columns: minmax(0, 1fr); } }
    .cartao { min-width: 0; padding: var(--espacamento-5); border: 1px solid var(--borda); border-radius: var(--raio-painel);
      background: var(--superficie-elevada); display: grid; gap: var(--espacamento-4); }
    h2, h3 { margin: 0; }
    .grade { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--espacamento-4); }
    .grade--3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    @container (max-width: 760px) { .grade, .grade--3 { grid-template-columns: minmax(0, 1fr); } }
    .bloco { display: grid; gap: var(--espacamento-3); }
    .grupo { min-width: 0; margin: 0; padding: 0; border: 0; display: grid; gap: var(--espacamento-2); }
    .grupo legend { padding: 0; margin-bottom: var(--espacamento-1); }
    .ajuda { margin: 0; color: var(--texto-secundario); font-size: 13px; }
    .erro { margin: 0; color: var(--erro); font-size: 13px; }
    .erro-geral { margin: 0 0 var(--espacamento-3); padding: var(--espacamento-3); border-radius: var(--raio-controle);
      border: 1px solid var(--erro); color: var(--erro); font-size: 14px; }
    .aviso { display: flex; gap: var(--espacamento-2); align-items: flex-start; margin: 0; padding: var(--espacamento-3);
      border-radius: var(--raio-controle); font-size: 13px; color: var(--texto); }
    .aviso p { margin: var(--espacamento-1) 0 0; }
    .aviso--atencao { background: var(--atencao-suave); }
    .aviso--risco { background: var(--atencao-suave); border: 1px solid var(--atencao); }
    .confirma { display: flex; gap: var(--espacamento-2); align-items: flex-start; font-size: 14px; color: var(--texto); }
    .confirma input { margin-top: 3px; }
    .confirma--erro { color: var(--erro); }
    .previa-msg { padding: var(--espacamento-3); border-radius: var(--raio-controle); background: var(--superficie); }
    .previa-msg p { margin: var(--espacamento-1) 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; }
    .resumo { margin: 0; padding-left: var(--espacamento-5); display: grid; gap: var(--espacamento-1); font-size: 14px; }
    .previa { position: sticky; top: var(--espacamento-4); }
    @container (max-width: 980px) { .previa { position: static; } }
    .kpis { display: grid; gap: var(--espacamento-2); }
    .kpis--velha { opacity: .5; }
    .excluidos, .amostra { margin: 0; padding: 0; list-style: none; display: grid; gap: var(--espacamento-1); font-size: 13px; }
    .excluidos li { display: flex; justify-content: space-between; gap: var(--espacamento-3); }
    .amostra li { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cidade { color: var(--texto-suave); }
    .rodape { display: flex; flex-wrap: wrap; align-items: center; gap: var(--espacamento-2); margin-top: var(--espacamento-5); }
    .espaco { flex: 1; }
  `,
})
export class CampanhaWizardPagina implements OnInit {
  /** Rota `campanhas/:id/editar` (rascunho); sem `id` é criação. */
  readonly id = input<string | undefined>(undefined)

  private readonly api = inject(CampanhasServico)
  private readonly catalogos = inject(EtiquetasServico)
  private readonly router = inject(Router)
  private readonly toast = inject(ToastServico)

  protected readonly passos = PASSOS
  protected readonly opcoesSegmento = OPCOES_SEGMENTO
  protected readonly opcoesQualificacao = OPCOES_QUALIFICACAO

  protected readonly estado = signal<Estado>('carregando')
  protected readonly erroCarga = signal('')
  protected readonly form = signal<FormCampanha>(FORM_VAZIO)
  protected readonly passo = signal<PassoWizard>('detalhes')
  /** Índice do passo mais avançado já liberado (o stepper só deixa voltar/ir até ele). */
  protected readonly alcancado = signal(0)
  protected readonly passosComErroVisivel = signal<ReadonlySet<PassoWizard>>(new Set())
  protected readonly errosApi = signal<ErrosCampo>({})
  protected readonly erroGeral = signal<string | null>(null)
  protected readonly faltandoApi = signal<readonly number[]>([])
  protected readonly salvando = signal(false)

  protected readonly canais = signal<readonly CanalCampanha[]>([])
  protected readonly etapas = signal<readonly EtapaFunil[]>([])
  protected readonly templateCtl = new FormControl<string | null>(null)
  protected readonly templateInjetado = signal<OpcaoPaginada | null>(null)
  protected readonly templateSel = signal<{ id: string; texto: string | null; mapa: Readonly<Record<string, string>> | null } | null>(null)
  private readonly templatesVistos = new Map<string, TemplateCampanha>()

  protected readonly previa = signal<PreviaApi | null>(null)
  protected readonly previaEstado = signal<EstadoPrevia>('ocioso')
  protected readonly previaErro = signal('')
  private chavePrevia = ''
  private ultimoEstadoPrevia: EstadoPrevia = 'ocioso'
  private geracaoPrevia = 0

  protected readonly editando = computed(() => !!this.id())
  protected readonly indicePasso = computed(() => PASSOS.indexOf(this.passo()))
  protected readonly canaisWhatsapp = computed(() => this.canais().filter((c) => c.tipo === TIPO_OFICIAL || c.tipo === TIPO_NAO_OFICIAL))
  protected readonly opcoesCanal = computed<OpcaoSelect[]>(() => this.canaisWhatsapp().map((c) => ({
    valor: c.id, rotulo: `${c.nomeAmigavel} (${c.tipo === TIPO_OFICIAL ? 'oficial' : 'não oficial'})`,
  })))
  protected readonly opcoesEtapa = computed<OpcaoChip[]>(() => this.etapas()
    .filter((e) => e.tipo === 'aberto' && e.ativo).map((e) => ({ valor: e.id, rotulo: e.nome })))
  protected readonly ehOficial = computed(() => this.form().canalTipo === TIPO_OFICIAL)
  protected readonly ehNaoOficial = computed(() => this.form().canalTipo === TIPO_NAO_OFICIAL)
  protected readonly trilha = computed<ItemTrilha[]>(() => [
    { rotulo: 'Campanhas', rota: '/campanhas' }, { rotulo: this.editando() ? 'Editar' : 'Nova campanha' },
  ])

  /** Erros visíveis: os de passos já tentados (cliente) mais os que a API devolveu (têm prioridade). */
  protected readonly erros = computed<ErrosCampo>(() => {
    const f = this.form()
    const locais: Record<string, string> = {}
    for (const p of this.passosComErroVisivel()) Object.assign(locais, errosDoPasso(p, f))
    return { ...locais, ...this.errosApi() }
  })

  protected readonly variaveisFaltando = computed<readonly number[]>(() => {
    const api = this.faltandoApi()
    if (api.length > 0) return api
    const t = this.templateSel()
    return t?.texto ? variaveisSemMapeamento(t.texto, t.mapa) : []
  })
  protected readonly textoFaltando = computed(() => textoVariaveisFaltando(this.variaveisFaltando()))

  protected readonly itensRevisao = computed<ItemDefinicao[]>(() => {
    const f = this.form()
    const canal = this.canais().find((c) => c.id === f.canalId)
    const p = this.previa()
    return [
      { rotulo: 'Nome', valor: f.nome.trim() },
      { rotulo: 'Número', valor: canal ? `${canal.nomeAmigavel} (${f.canalTipo === TIPO_OFICIAL ? 'oficial' : 'não oficial'})` : null },
      f.canalTipo === TIPO_OFICIAL
        ? { rotulo: 'Template', valor: this.templateInjetado()?.rotulo ?? f.templateId }
        : { rotulo: 'Texto', valor: f.mensagem.trim() },
      { rotulo: 'Elegíveis', valor: p ? `${p.elegiveis} de ${p.total}` : null },
      { rotulo: 'Custo estimado', valor: p ? `${formatarCusto(p.custoEstimadoCentavos)} (${textoPrecoUnitario(p.precoUnitarioCentavos)})` : null },
      { rotulo: 'Lote diário', valor: `${loteEfetivo(f)} por dia${p ? ` · ${textoDuracao(p.duracaoDias).toLowerCase()}` : ''}` },
      { rotulo: 'Início', valor: f.inicioEm ? new Date(f.inicioEm).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : 'Ao iniciar' },
      { rotulo: 'Janela de envio', valor: f.janelaPropria ? resumoJanela(f.janela) : (p ? `${resumoJanela(p.janelaDoNumero.horario)} (${ROTULO_ORIGEM_JANELA[p.janelaDoNumero.origem] ?? p.janelaDoNumero.origem})` : 'A do número') },
      { rotulo: 'Janela de resposta', valor: `${f.janelaDias} dias` },
    ]
  })
  protected readonly linhasPublico = computed(() => resumoPublico(this.form().publico, rotuloSegmento, (c) => (ROTULO_QUALIFICACAO as Record<string, string>)[c] ?? c))

  constructor() {
    this.templateCtl.valueChanges.subscribe((v) => this.escolherTemplate(v))
    // Prévia com debounce: cada mudança de público/lote/template reinicia a espera; só a última resposta vale.
    effect((onCleanup) => {
      if (this.estado() !== 'pronto' || this.passo() === 'detalhes') return
      const corpo = montarCorpoPrevia(this.form())
      if (!corpo) { this.previaEstado.set('ocioso'); this.previa.set(null); this.chavePrevia = ''; return }
      const chave = JSON.stringify(corpo)
      if (chave === this.chavePrevia) { this.previaEstado.set(this.ultimoEstadoPrevia); return }
      this.previaEstado.set('carregando')
      const t = setTimeout(() => void this.buscarPrevia(corpo, chave), ATRASO_PREVIA_MS)
      onCleanup(() => clearTimeout(t))
    })
  }

  ngOnInit(): void { void this.carregar() }

  protected rotuloPasso(p: PassoWizard): string { return ROTULO_PASSO[p] }
  protected erro(campo: string): string | null { return this.erros()[campo] ?? null }
  protected valoresDe(o: readonly OpcaoEscolhida[]): string[] { return o.map((x) => x.valor) }
  protected mutavel(v: readonly string[]): string[] { return [...v] }
  protected custo(p: PreviaApi): string { return formatarCusto(p.custoEstimadoCentavos) }
  protected textoPreco(p: PreviaApi): string { return `custo estimado · ${textoPrecoUnitario(p.precoUnitarioCentavos)}` }
  protected duracao(p: PreviaApi): string { return textoDuracao(p.duracaoDias) }
  protected aquecimento(p: PreviaApi): string | null { return textoAquecimento(p.aquecimento) }
  protected excluidos(p: PreviaApi) { return excluidosOrdenados(p.excluidos, MOTIVOS_EXCLUSAO) }
  protected rotuloExclusao(m: string): string { return (ROTULO_MOTIVO_EXCLUSAO as Record<string, string>)[m] ?? m }
  protected rotuloOrigemJanela(o: string): string { return ROTULO_ORIGEM_JANELA[o] ?? o }
  protected resumoDaJanela(p: PreviaApi): string { return resumoJanela(p.janelaDoNumero.horario) }

  protected async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      const [canais, etapas] = await Promise.all([
        this.api.canais(),
        this.api.etapas().then((r) => r.itens).catch(() => [] as readonly EtapaFunil[]),
      ])
      this.canais.set(canais.itens)
      this.etapas.set(etapas)
      const id = this.id()
      if (id) {
        const d = await this.api.obter(id)
        if (!d.acoes.editar) { this.estado.set('nao_editavel'); return }
        await this.aplicarDetalhe(d)
        this.alcancado.set(PASSOS.length - 1)
      }
      this.estado.set('pronto')
    } catch (e) {
      if (ehStatus(e, 403)) this.estado.set('sem_permissao')
      else if (ehStatus(e, 404)) { this.erroCarga.set('Esta campanha não existe mais.'); this.estado.set('erro') }
      else { this.erroCarga.set(mensagemDeErro(e, 'Verifique a conexão e tente de novo.')); this.estado.set('erro') }
    }
  }

  /** Rascunho gravado → formulário. O público só guarda ids: os rótulos vêm dos catálogos (até um teto de páginas). */
  private async aplicarDetalhe(d: CampanhaDetalhe): Promise<void> {
    const p = d.publico ?? {}
    const [listas, etiquetas, origens] = await Promise.all([
      this.rotulosPorId(p.listas ?? [], (c) => this.api.listas(c).then((r) => ({ itens: r.itens.map((i) => ({ id: i.id, nome: i.nome })), proximoCursor: r.proximoCursor }))),
      this.rotulosPorId(p.etiquetas ?? [], (c) => this.catalogos.etiquetas(c, false).then((r) => ({ itens: r.itens.map((i) => ({ id: i.id, nome: i.nome })), proximoCursor: r.proximoCursor }))),
      this.rotulosPorId(p.origens ?? [], (c) => this.catalogos.origens(c, false).then((r) => ({ itens: r.itens.map((i) => ({ id: i.id, nome: i.nome })), proximoCursor: r.proximoCursor }))),
    ])
    const etapas = new Map(this.etapas().map((e) => [e.id, e.nome]))
    this.form.set(formDaCampanha(d, (tipo, id) => {
      if (tipo === 'listas') return listas.get(id) ?? null
      if (tipo === 'etiquetas') return etiquetas.get(id) ?? null
      if (tipo === 'origens') return origens.get(id) ?? null
      return etapas.get(id) ?? null
    }))
    if (d.template) {
      this.templateInjetado.set({ valor: d.template.id, rotulo: d.template.nome ?? 'Template' })
      this.templateCtl.setValue(d.template.id, { emitEvent: false })
      this.templateSel.set({ id: d.template.id, texto: null, mapa: null })
    }
  }

  /** Procura os ids nas páginas do catálogo, parando quando todos foram achados ou no teto. */
  private async rotulosPorId(
    ids: readonly string[], pagina: (cursor: string | null) => Promise<{ itens: { id: string; nome: string }[]; proximoCursor: string | null }>,
  ): Promise<Map<string, string>> {
    const achados = new Map<string, string>()
    if (ids.length === 0) return achados
    let cursor: string | null = null
    for (let i = 0; i < MAX_PAGINAS_ROTULO; i++) {
      try {
        const r = await pagina(cursor)
        for (const it of r.itens) if (ids.includes(it.id)) achados.set(it.id, it.nome)
        cursor = r.proximoCursor
      } catch { break }
      if (achados.size === ids.length || !cursor) break
    }
    return achados
  }

  // ── edição do formulário ──
  protected atualizar(patch: Partial<FormCampanha>): void {
    this.form.update((f) => ({ ...f, ...patch }))
    this.errosApi.set({})
    this.erroGeral.set(null)
    if ('templateId' in patch) this.faltandoApi.set([])
  }

  protected atualizarPublico(patch: Partial<PublicoForm>): void {
    this.atualizar({ publico: { ...this.form().publico, ...patch } })
  }

  protected escolherEtapas(ids: string[]): void {
    const nomes = new Map(this.opcoesEtapa().map((o) => [o.valor, o.rotulo]))
    this.atualizarPublico({ etapas: ids.map((v) => ({ valor: v, rotulo: nomes.get(v) ?? v })) })
  }

  protected escolherCanal(id: string): void {
    const canal = this.canais().find((c) => c.id === id)
    const tipo = canal?.tipo ?? ''
    const mudouTipo = tipo !== this.form().canalTipo
    this.atualizar({
      canalId: id, canalTipo: tipo,
      ...(mudouTipo ? { templateId: '', confirmaRiscoBanimento: false } : {}),
    })
    if (mudouTipo) {
      this.templateCtl.setValue(null, { emitEvent: false })
      this.templateInjetado.set(null)
      this.templateSel.set(null)
    }
  }

  private escolherTemplate(id: string | null): void {
    this.atualizar({ templateId: id ?? '' })
    const t = id ? this.templatesVistos.get(id) : undefined
    this.templateSel.set(id ? { id, texto: t?.corpo.body.texto ?? null, mapa: t?.mapeamentoVariaveis ?? null } : null)
    if (t) this.templateInjetado.set({ valor: t.id, rotulo: t.nome })
  }

  // ── carregadores dos selects paginados (cursor; busca e filtros no servidor) ──
  protected readonly carregarTemplates: CarregarOpcoes = async (cursor, termo): Promise<PaginaOpcoes> => {
    const r = await this.api.templates(cursor, {
      status: 'APPROVED', categoria: 'MARKETING', canalId: this.form().canalId || null, q: termo || null,
    })
    const itens: OpcaoPaginada[] = []
    for (const t of r.itens) {
      this.templatesVistos.set(t.id, t)
      itens.push({ valor: t.id, rotulo: t.nome, dica: t.corpo.body.texto.slice(0, 70) })
    }
    return { itens, proximoCursor: r.proximoCursor }
  }

  protected readonly carregarListas: CarregarOpcoes = async (cursor, termo) => {
    const r = await this.api.listas(cursor, termo || null)
    return { itens: r.itens.map((l) => ({ valor: l.id, rotulo: l.nome })), proximoCursor: r.proximoCursor }
  }

  protected readonly carregarEtiquetas: CarregarOpcoes = async (cursor, termo) => {
    const r = await this.catalogos.etiquetas(cursor, true, termo || null)
    return { itens: r.itens.map((e) => ({ valor: e.id, rotulo: e.nome })), proximoCursor: r.proximoCursor }
  }

  protected readonly carregarOrigens: CarregarOpcoes = async (cursor, termo) => {
    const r = await this.catalogos.origens(cursor, true, termo || null)
    return { itens: r.itens.map((o) => ({ valor: o.id, rotulo: o.nome })), proximoCursor: r.proximoCursor }
  }

  // ── prévia ──
  private async buscarPrevia(corpo: NonNullable<ReturnType<typeof montarCorpoPrevia>>, chave: string): Promise<void> {
    const geracao = ++this.geracaoPrevia
    try {
      const r = await this.api.previa(corpo)
      if (geracao !== this.geracaoPrevia) return
      this.chavePrevia = chave
      this.previa.set(r)
      this.ultimoEstadoPrevia = 'pronto'
      this.previaEstado.set('pronto')
    } catch (e) {
      if (geracao !== this.geracaoPrevia) return
      // Chave guardada mesmo no erro: não repete a mesma chamada em laço; mudar o formulário tenta de novo.
      this.chavePrevia = chave
      const m = mapearErro(corpoDoErro(e), 'Não foi possível calcular a prévia.')
      this.previaErro.set(m.geral ?? Object.values(m.campos)[0] ?? 'Não foi possível calcular a prévia.')
      this.ultimoEstadoPrevia = 'erro'
      this.previaEstado.set('erro')
    }
  }

  // ── navegação entre passos ──
  protected irPara(p: PassoWizard): void {
    if (PASSOS.indexOf(p) <= this.alcancado()) this.passo.set(p)
  }

  protected avancar(): void {
    const atual = this.passo()
    this.marcarVisivel(atual)
    if (Object.keys(errosDoPasso(atual, this.form())).length > 0) return
    const prox = PASSOS[this.indicePasso() + 1]
    if (!prox) return
    this.passo.set(prox)
    this.alcancado.update((a) => Math.max(a, PASSOS.indexOf(prox)))
  }

  protected voltar(): void {
    const ant = PASSOS[this.indicePasso() - 1]
    if (ant) this.passo.set(ant)
  }

  private marcarVisivel(p: PassoWizard): void {
    this.passosComErroVisivel.update((s) => new Set(s).add(p))
  }

  protected cancelar(): void {
    const id = this.id()
    void this.router.navigate(id ? ['/campanhas', id] : ['/campanhas'])
  }

  protected voltarAoDetalhe(): void { this.cancelar() }
  protected irParaNumeros(): void { void this.router.navigate(['/numeros']) }

  // ── salvar ──
  protected async salvar(): Promise<void> {
    if (this.salvando()) return
    const pendentes = passosComErro(this.form())
    if (pendentes.length > 0) {
      for (const p of pendentes) this.marcarVisivel(p)
      this.passo.set(pendentes[0] ?? 'detalhes')
      this.erroGeral.set('Confira os campos destacados antes de salvar.')
      return
    }
    this.salvando.set(true); this.erroGeral.set(null)
    try {
      const corpo = montarCorpo(this.form())
      const id = this.id()
      if (id) {
        await this.api.editar(id, corpo)
        this.toast.sucesso('Rascunho atualizado.')
        await this.router.navigate(['/campanhas', id])
      } else {
        const r = await this.api.criar(corpo)
        this.toast.sucesso('Rascunho salvo. Envie um teste e inicie quando estiver pronto.')
        await this.router.navigate(['/campanhas', r.id])
      }
    } catch (e) {
      if (ehStatus(e, 403)) { this.erroGeral.set('Você não tem permissão para salvar campanhas.'); return }
      const m = mapearErro(corpoDoErro(e), mensagemDeErro(e, 'Não foi possível salvar a campanha.'))
      this.errosApi.set(m.campos)
      this.faltandoApi.set(m.faltando)
      this.erroGeral.set(m.geral ?? 'Confira os campos destacados.')
      if (m.passo) this.passo.set(m.passo)
    } finally { this.salvando.set(false) }
  }
}
