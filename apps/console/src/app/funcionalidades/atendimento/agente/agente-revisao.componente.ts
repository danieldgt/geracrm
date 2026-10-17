import { Component, ChangeDetectionStrategy, computed, effect, inject, input, signal, untracked } from '@angular/core'
import {
  CRITERIOS_RUBRICA, DECISOES_REVISAO, DESCRICAO_CRITERIO, META_CONCORDANCIA, MIN_REVISADAS_CONCORDANCIA, ROTULO_CRITERIO,
  ROTULO_DECISAO, ROTULO_VEREDITO, VEREDITOS_REVISAO, deslocarSemana, somarConcordancia,
  type AmostraRevisaoDto, type ConcordanciaDto, type CriterioRubrica, type DecisaoRevisao, type DetalheRevisaoDto,
  type FalaRevisao, type GravidadeQualidade, type ItemAmostraRevisaoDto, type SomaConcordancia, type VereditoRevisao,
} from '@geracrm/shared'
import {
  BadgeComponente, BotaoComponente, EsqueletoComponente, EstadoComponente, PainelComponente, ToastServico,
} from '../../../compartilhado/ui/index.js'
import { ehSemPermissao } from './agente.servico.js'
import { RevisaoServico } from './revisao.servico.js'
import { badgeGravidade, formatarNota, linhaDaViolacao, tomDaNota } from './qualidade.regras.js'
import {
  corpoDoFormulario, formatarPercentual, formularioDe, formularioVazio, mensagemDaFalhaRevisao, progressoDaAmostra,
  resultadoDaRevisao, rotuloGravidade, rotuloMotivo, rotuloSemana, semanaDeHoje, situacaoDaConcordancia,
  type ErrosFormulario, type FormularioRevisao,
} from './revisao.regras.js'

/**
 * REVISÃO HUMANA E CONCORDÂNCIA (ADR-031 §5, raia P16) — aba "Revisão" do agente.
 *
 *   1. Concordância da semana: humano × juiz no número (meta ≥ 85% com ≥ 20
 *      comparáveis), por critério, só aleatórias, falso negativo CRÍTICO — e a
 *      mesma linha para todos os números do tenant. Exporta a planilha.
 *   2. Amostra da semana do número (20, na ordem da P12) com "revisada ou não".
 *   3. Revisar: a conversa mascarada (em sombra, a SUGESTÃO do agente, não o
 *      que o vendedor enviou) ao lado do formulário — nota 0–5 por critério,
 *      gravidade, veredito e decisão com responsável e prazo. As notas do juiz
 *      ficam ao lado, recolhidas até o revisor pedir (ou gravar), para não
 *      ancorar a nota humana.
 *
 * Cinco estados como ramos explícitos: carregando (esqueleto), erro (tentar de
 * novo), sem permissão (gestor/admin), vazio (semana sem avaliação: ir para a
 * anterior) e pronto; a concordância que falha sozinha vira aviso (parcial).
 */
export const ABA_REVISAO_PRONTA: boolean = true

type Estado = 'carregando' | 'pronto' | 'erro' | 'sem_permissao'
const GRAVIDADES: ReadonlyArray<GravidadeQualidade | null> = [null, 'MEDIA', 'ALTA', 'CRITICA']
const NOTAS = [0, 1, 2, 3, 4, 5] as const

@Component({
  selector: 'app-agente-revisao',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PainelComponente, EstadoComponente, EsqueletoComponente, BotaoComponente, BadgeComponente],
  template: `
    <ui-painel>
      <div class="cab">
        <div class="semana" role="group" aria-label="Semana revisada">
          <button type="button" class="nav" (click)="andar(-1)" aria-label="Semana anterior">‹</button>
          <span class="txt-secao rotulo-semana">{{ rotuloDaSemana() }}</span>
          <button type="button" class="nav" (click)="andar(1)" [disabled]="ehSemanaAtual()" aria-label="Próxima semana">›</button>
        </div>
        @if (estado() === 'pronto') {
          <ui-botao variante="secundario" (click)="exportar()" [carregando]="exportando()">
            {{ exportando() ? 'Exportando…' : 'Exportar planilha (CSV)' }}</ui-botao>
        }
      </div>
      <p class="dica">Toda semana, um gestor revisa até 20 conversas por número — primeiro as críticas, depois as de nota baixa,
        depois aleatórias — e dá a própria nota. Quando a nota humana e a do juiz batem (diferença de até 1 ponto em cada
        critério e mesma gravidade) em pelo menos {{ meta }} das revisões, a nota do juiz passa a valer como critério de fase.</p>
    </ui-painel>

    @switch (estado()) {
      @case ('carregando') {
        <ui-painel><div class="esq">
          <ui-esqueleto altura="20px" largura="40%" />
          <div class="kpis"><ui-esqueleto altura="64px" /><ui-esqueleto altura="64px" /><ui-esqueleto altura="64px" /></div>
        </div></ui-painel>
        <ui-painel><div class="esq"><ui-esqueleto altura="44px" /><ui-esqueleto altura="44px" /><ui-esqueleto altura="44px" /></div></ui-painel>
      }
      @case ('sem_permissao') {
        <ui-painel><ui-estado tipo="sem-permissao" titulo="A revisão humana é de gestor ou administrador"
          descricao="Peça a um administrador o papel de gestor para revisar as conversas do agente." /></ui-painel>
      }
      @case ('erro') {
        <ui-painel><ui-estado tipo="erro" titulo="Não foi possível carregar a amostra da semana"
          descricao="O servidor do GeraCRM não respondeu. Dá para tentar de novo.">
          <ui-botao variante="secundario" (click)="carregar()">Tentar de novo</ui-botao>
        </ui-estado></ui-painel>
      }
      @case ('pronto') {
        <!-- 1. Concordância -->
        <ui-painel>
          <h3 class="txt-secao titulo">Concordância humano × juiz <span class="escopo">· este número</span></h3>
          @if (concordancia(); as c) {
            @if (doNumero(); as n) {
              <div class="kpis">
                <div class="kpi" [class.alerta]="sit().tom === 'erro'" [class.ok]="sit().tom === 'sucesso'">
                  <span class="txt-rotulo">Concordância</span>
                  <span class="txt-kpi txt-dados">{{ pct(n.concordancia) }}</span>
                  <span class="suave">meta {{ meta }} · {{ n.concordantes }} de {{ n.comparaveis }}</span>
                </div>
                <div class="kpi"><span class="txt-rotulo">Conversas com juiz</span>
                  <span class="txt-kpi txt-dados">{{ n.conversasComparaveis }}<span class="de">/{{ minimo }}</span></span>
                  <span class="suave">{{ n.revisadas }} conversa(s) revisada(s) · {{ n.revisoes }} revisão(ões); conta a 1ª de cada conversa</span></div>
                <div class="kpi"><span class="txt-rotulo">Só aleatórias</span>
                  <span class="txt-kpi txt-dados">{{ pct(n.aleatorias.concordancia) }}</span>
                  <span class="suave">{{ n.aleatorias.comparaveis }} comparável(is) — estima a concordância real</span></div>
                <div class="kpi" [class.alerta]="n.falsosNegativosCritica > 0"><span class="txt-rotulo">Crítica que o juiz não viu</span>
                  <span class="txt-kpi txt-dados">{{ n.falsosNegativosCritica }}</span></div>
              </div>
              <div class="situacao">
                <ui-badge [tom]="sit().tom">{{ sit().rotulo }}</ui-badge>
                @if (sit().detalhe; as d) { <span class="suave">{{ d }}</span> }
              </div>
              @if (n.comparaveis > 0) {
                <ul class="criterios" aria-label="Concordância por critério">
                  @for (k of criterios; track k) {
                    <li>
                      <span class="crit-nome">{{ rotuloCriterio(k) }}</span>
                      <span class="barra" role="meter" [attr.aria-label]="rotuloCriterio(k)" aria-valuemin="0" aria-valuemax="100"
                            [attr.aria-valuenow]="largura(n.porCriterio[k])">
                        <span class="barra-cheia" [style.width.%]="largura(n.porCriterio[k])"></span></span>
                      <span class="txt-dados">{{ pct(n.porCriterio[k]) }}</span>
                    </li>
                  }
                  <li>
                    <span class="crit-nome">Gravidade</span>
                    <span class="barra" role="meter" aria-label="Gravidade" aria-valuemin="0" aria-valuemax="100" [attr.aria-valuenow]="largura(n.gravidade)">
                      <span class="barra-cheia" [style.width.%]="largura(n.gravidade)"></span></span>
                    <span class="txt-dados">{{ pct(n.gravidade) }}</span>
                  </li>
                </ul>
              }
            }
            @if (c.porNumero.length > 0) {
              <h4 class="txt-rotulo sub">Todos os números · {{ semanaCurta() }}</h4>
              <ul class="numeros">
                @for (x of c.porNumero; track x.canalId) {
                  <li [class.atual]="x.canalId === canalId()">
                    <span class="encolhe nome">{{ x.nome }}</span>
                    <span class="txt-dados">{{ pct(x.concordancia) }}</span>
                    <span class="suave txt-dados">{{ x.comparaveis }}/{{ minimo }}</span>
                    <ui-badge [tom]="situacaoDe(x).tom">{{ situacaoDe(x).rotulo }}</ui-badge>
                  </li>
                }
              </ul>
            }
          } @else {
            <p class="parcial" role="status">A concordância não carregou agora; a amostra abaixo continua valendo.
              <button type="button" class="link" (click)="carregarConcordancia()">Tentar de novo</button></p>
          }
        </ui-painel>

        <!-- 2. Amostra -->
        <ui-painel>
          <div class="cab">
            <h3 class="txt-secao titulo">Amostra da semana <span class="escopo">· este número</span></h3>
            @if (itens().length > 0) {
              <span class="progresso txt-dados" role="status">{{ progresso().revisadas }} de {{ progresso().total }} revisadas</span>
            }
          </div>
          @if (itens().length === 0) {
            <ui-estado titulo="Nenhuma conversa avaliada nesta semana" icone="🗓️"
              descricao="A amostra nasce das avaliações de qualidade das respostas e sugestões do agente. A revisão costuma ser feita na segunda-feira, sobre a semana anterior.">
              <ui-botao variante="secundario" (click)="andar(-1)">Ver a semana anterior</ui-botao>
            </ui-estado>
          } @else {
            <ol class="lista">
              @for (i of itens(); track i.avaliacaoId) {
                <li class="item" [class.aberto]="aberto() === i.avaliacaoId">
                  <div class="linha">
                    <span class="txt-dados ordem">{{ i.ordem }}</span>
                    @if (i.cego) {
                      <!-- Cego até revisar: nem motivo, nem gravidade, nem nota (o servidor nem manda). -->
                      <ui-badge tom="neutro">Na amostra</ui-badge>
                      <span class="encolhe resumo">{{ i.origem === 'agente' ? 'Autônomo' : 'Sugestão' }} · {{ i.comJuiz ? 'com nota do juiz' : 'sem nota do juiz' }}</span>
                    } @else {
                      <ui-badge [tom]="i.motivo === 'critica' ? 'erro' : i.motivo === 'aleatoria' ? 'neutro' : 'atencao'">{{ motivo(i) }}</ui-badge>
                      <span class="encolhe resumo">
                        Regras: {{ grav(i.piorGravidade) }} · Juiz: {{ i.menorNota === null ? 'sem nota' : nota(i.menorNota) }}
                        · {{ i.origem === 'agente' ? 'Autônomo' : 'Sugestão' }}
                      </span>
                    }
                    @if (i.revisao; as r) {
                      <ui-badge [tom]="r.concorda === false ? 'atencao' : 'sucesso'">Revisada{{ r.concorda === false ? ' · diverge' : '' }}</ui-badge>
                    } @else {
                      <ui-badge tom="neutro">Pendente</ui-badge>
                    }
                    @if (i.revisoes > (i.revisao ? 1 : 0)) {
                      <span class="suave">+{{ i.revisoes - (i.revisao ? 1 : 0) }} revisor(es)</span>
                    }
                    <ui-botao variante="fantasma" (click)="alternar(i)" [attr.aria-expanded]="aberto() === i.avaliacaoId">
                      {{ aberto() === i.avaliacaoId ? 'Fechar' : i.revisao ? 'Ver ou refazer' : 'Revisar' }}</ui-botao>
                  </div>

                  @if (aberto() === i.avaliacaoId) {
                    @switch (estadoDetalhe()) {
                      @case ('carregando') { <div class="esq"><ui-esqueleto altura="120px" /><ui-esqueleto altura="44px" /></div> }
                      @case ('erro') {
                        <ui-estado tipo="erro" titulo="Não foi possível abrir a conversa" descricao="Dá para tentar de novo.">
                          <ui-botao variante="secundario" (click)="abrir(i)">Tentar de novo</ui-botao></ui-estado>
                      }
                      @case ('pronto') {
                        @if (detalhe(); as d) {
                          <div class="revisar">
                            <!-- Conversa -->
                            <section class="conversa" aria-label="Conversa (dados pessoais mascarados)">
                              <h4 class="txt-rotulo sub">Conversa</h4>
                              @if (d.origem === 'sugestao') {
                                <p class="aviso-sombra">Avalie a <strong>sugestão do agente</strong> — o texto que ele decidiu — e não o que o vendedor editou e enviou.</p>
                              }
                              @if (d.cortada) { <p class="suave">Conversa longa: mostrando o final.</p> }
                              @if (d.transcricao.length === 0) {
                                <p class="suave">A transcrição desta sessão não está disponível.</p>
                              } @else {
                                <ol class="falas">
                                  @for (f of d.transcricao; track $index) {
                                    <li class="fala" [attr.data-autor]="f.autor">
                                      <span class="autor">{{ autor(f) }}</span>
                                      <span class="texto">{{ f.texto }}</span>
                                    </li>
                                  }
                                </ol>
                              }
                              @if (d.violacoes.length > 0) {
                                <h4 class="txt-rotulo sub">O que as regras pegaram</h4>
                                <ul class="violacoes">
                                  @for (v of d.violacoes; track $index) {
                                    <li>@if (v.gravidade; as g) { <ui-badge [tom]="badgeG(g).tom">{{ badgeG(g).rotulo }}</ui-badge> }
                                      @if (v.regra) { <span>{{ violacao(v) }}</span> }
                                      @if (v.trecho) { <q class="trecho">{{ v.trecho }}</q> }</li>
                                  }
                                </ul>
                              }
                            </section>

                            <!-- Formulário -->
                            <form class="form" (submit)="$event.preventDefault(); salvar(i)" novalidate>
                              <div class="form-cab">
                                <h4 class="txt-rotulo sub">Sua avaliação</h4>
                                @if (!d.comJuiz) { <span class="suave">Sem nota do juiz — esta revisão não entra na concordância.</span> }
                              </div>
                              @if (d.cego) {
                                <p class="suave">Dê a sua nota sem ver a do juiz. As notas dele e a gravidade das regras aparecem depois que você salvar.</p>
                              } @else {
                                <p class="suave">Notas e gravidade ficam fixas na 1ª gravação (são a base da concordância). Veredito, decisão, responsável, prazo e observação podem mudar.</p>
                              }
                              @for (k of criterios; track k) {
                                <fieldset class="criterio" [attr.aria-describedby]="erros().notas && form().notas[k] === undefined ? idErro('notas') : null">
                                  <legend class="c-nome">{{ rotuloCriterio(k) }}</legend>
                                  <p class="c-desc">{{ descricao(k) }}</p>
                                  <div class="c-linha">
                                    <span class="notas">
                                      @for (n of notas; track n) {
                                        <label class="n" [class.sel]="form().notas[k] === n" [class.travado]="travado()">
                                          <input type="radio" class="vh" [name]="'nota-' + k" [value]="n" [checked]="form().notas[k] === n"
                                                 [disabled]="travado()" (change)="darNota(k, n)" />
                                          <span aria-hidden="true">{{ n }}</span><span class="vh">nota {{ n }}</span>
                                        </label>
                                      }
                                    </span>
                                    @if (d.notasJuiz; as nj) {
                                      <span class="juiz">
                                        <ui-badge [tom]="tomNota(nj[k] ?? null)">Juiz {{ nj[k] ?? '—' }}</ui-badge>
                                        @if (d.justificativas?.[k]; as j) { <span class="just">{{ j }}</span> }
                                      </span>
                                    }
                                  </div>
                                </fieldset>
                              }
                              @if (erros().notas; as e) { <span class="msg-erro" role="alert" [id]="idErro('notas')">{{ e }}</span> }

                              <fieldset class="grupo" [attr.aria-describedby]="erros().gravidade ? idErro('gravidade') : null">
                                <legend>Gravidade que você viu</legend>
                                <span class="opcoes">
                                  @for (g of gravidades; track $index) {
                                    <label class="op" [class.sel]="form().gravidade === g" [class.travado]="travado()">
                                      <input type="radio" class="vh" name="gravidade" [checked]="form().gravidade === g" [disabled]="travado()"
                                             (change)="campo('gravidade', g)" />{{ grav(g) }}</label>
                                  }
                                </span>
                                @if (!d.cego) { <span class="suave">Regras nesta sessão: {{ grav(d.gravidadeSistema) }}</span> }
                                @if (erros().gravidade; as e) { <span class="msg-erro" role="alert" [id]="idErro('gravidade')">{{ e }}</span> }
                              </fieldset>

                              <fieldset class="grupo" [attr.aria-describedby]="erros().veredito ? idErro('veredito') : null">
                                <legend>Veredito</legend>
                                @for (v of vereditos; track v) {
                                  <label class="radio"><input type="radio" name="veredito" [checked]="form().veredito === v" (change)="campo('veredito', v)" />
                                    {{ rotuloVeredito(v) }}</label>
                                }
                                @if (erros().veredito; as e) { <span class="msg-erro" role="alert" [id]="idErro('veredito')">{{ e }}</span> }
                              </fieldset>

                              <label class="campo">
                                <span>Decisão</span>
                                <select [value]="form().decisao" (change)="campo('decisao', $any($event.target).value)">
                                  @for (x of decisoes; track x) { <option [value]="x" [selected]="form().decisao === x">{{ rotuloDecisao(x) }}</option> }
                                </select>
                              </label>
                              @if (form().decisao !== 'nenhuma') {
                                <div class="dupla">
                                  <label class="campo">
                                    <span>Responsável</span>
                                    <input type="text" maxlength="120" [value]="form().responsavel" (input)="campo('responsavel', $any($event.target).value)"
                                           [attr.aria-invalid]="erros().responsavel ? 'true' : null"
                                           [attr.aria-describedby]="erros().responsavel ? idErro('responsavel') : null" />
                                    @if (erros().responsavel; as e) { <span class="msg-erro" role="alert" [id]="idErro('responsavel')">{{ e }}</span> }
                                  </label>
                                  <label class="campo">
                                    <span>Prazo</span>
                                    <input type="date" [value]="form().prazo" (input)="campo('prazo', $any($event.target).value)"
                                           [attr.aria-invalid]="erros().prazo ? 'true' : null"
                                           [attr.aria-describedby]="erros().prazo ? idErro('prazo') : null" />
                                    @if (erros().prazo; as e) { <span class="msg-erro" role="alert" [id]="idErro('prazo')">{{ e }}</span> }
                                  </label>
                                </div>
                              }
                              <label class="campo">
                                <span>Observação (opcional)</span>
                                <textarea rows="2" maxlength="1000" [value]="form().observacao" (input)="campo('observacao', $any($event.target).value)"></textarea>
                                <small>Não escreva telefone, CPF ou e-mail do cliente.</small>
                              </label>

                              @if (i.revisao; as r) {
                                <p class="resultado" [attr.data-tom]="resultado(r).tom" role="status">{{ resultado(r).rotulo }}</p>
                              }
                              <div class="acoes">
                                <ui-botao tipo="submit" [carregando]="salvando()">{{ salvando() ? 'Salvando…' : i.revisao ? 'Salvar de novo' : 'Salvar revisão' }}</ui-botao>
                              </div>
                            </form>
                          </div>
                        }
                      }
                    }
                  }
                </li>
              }
            </ol>
          }
        </ui-painel>
      }
    }
  `,
  styles: `
    :host { display: grid; gap: var(--espacamento-4); grid-template-columns: minmax(0, 1fr); min-width: 0; }
    .esq { display: grid; gap: var(--espacamento-3); }
    .cab { display: flex; justify-content: space-between; align-items: center; gap: var(--espacamento-2); flex-wrap: wrap; }
    .titulo { margin: 0 0 var(--espacamento-3); color: var(--texto); }
    .cab .titulo { margin: 0; }
    .escopo { color: var(--texto-suave); font-weight: 400; }
    .dica { margin: var(--espacamento-2) 0 0; color: var(--texto-suave); font-size: 13px; }
    .suave { color: var(--texto-suave); font-size: 12px; }
    .semana { display: flex; align-items: center; gap: var(--espacamento-2); min-width: 0; }
    .rotulo-semana { color: var(--texto); }
    .nav { font: inherit; font-size: 18px; line-height: 1; width: 32px; height: 32px; border: 1px solid var(--borda-controle);
      border-radius: var(--raio-controle); background: var(--superficie); color: var(--texto); cursor: pointer; }
    .nav:hover:not(:disabled) { background: var(--superficie-hover); }
    .nav:disabled { opacity: .4; cursor: default; }
    .kpis { display: grid; gap: var(--espacamento-3); grid-template-columns: repeat(auto-fit, minmax(min(150px, 100%), 1fr)); }
    .kpi { display: grid; gap: 2px; padding: var(--espacamento-3); border: 1px solid var(--borda); border-radius: var(--raio-controle);
      background: var(--superficie); min-width: 0; }
    .kpi.alerta { border-color: var(--erro); }
    .kpi.alerta .txt-kpi { color: var(--erro); }
    .kpi.ok { border-color: var(--sucesso); }
    .de { color: var(--texto-suave); font-size: 13px; margin-left: 2px; }
    .situacao { display: flex; gap: var(--espacamento-2); align-items: center; flex-wrap: wrap; margin-top: var(--espacamento-3); }
    .criterios { list-style: none; margin: var(--espacamento-3) 0 0; padding: 0; display: grid; gap: var(--espacamento-2); }
    .criterios li { display: grid; grid-template-columns: minmax(120px, 180px) 1fr 52px; gap: var(--espacamento-2); align-items: center; }
    .crit-nome { font-size: 13px; color: var(--texto-secundario); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .barra { height: 8px; border-radius: var(--raio-completo); background: var(--superficie-hover); overflow: hidden; }
    .barra-cheia { display: block; height: 100%; background: var(--acao); }
    .sub { margin: var(--espacamento-4) 0 var(--espacamento-2); }
    .numeros { list-style: none; margin: 0; padding: 0; border: 1px solid var(--borda); border-radius: var(--raio-controle); }
    .numeros li { display: grid; grid-template-columns: 1fr auto auto auto; gap: var(--espacamento-3); align-items: center;
      padding: var(--espacamento-2) var(--espacamento-3); border-bottom: 1px solid var(--borda); font-size: 13px; }
    .numeros li:last-child { border-bottom: none; }
    .numeros li.atual { background: var(--superficie-selecionada); }
    .encolhe { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .parcial { margin: 0; color: var(--atencao); font-size: 13px; }
    .progresso { color: var(--texto-secundario); font-size: 13px; }
    .lista { list-style: none; margin: var(--espacamento-3) 0 0; padding: 0; border: 1px solid var(--borda); border-radius: var(--raio-painel); overflow: hidden; }
    .item { padding: var(--espacamento-2) var(--espacamento-4); border-bottom: 1px solid var(--borda); display: grid; gap: var(--espacamento-3); min-width: 0; }
    .item:last-child { border-bottom: none; }
    .item.aberto { background: var(--superficie); }
    .linha { display: flex; align-items: center; gap: var(--espacamento-2); flex-wrap: wrap; min-width: 0; }
    .ordem { color: var(--texto-suave); width: 20px; text-align: right; }
    .resumo { flex: 1 1 200px; font-size: 13px; color: var(--texto-secundario); }
    .revisar { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr)); gap: var(--espacamento-4); align-items: start; }
    .conversa { min-width: 0; }
    .conversa .sub, .form .sub { margin-top: 0; }
    .aviso-sombra { margin: 0 0 var(--espacamento-2); padding: var(--espacamento-2) var(--espacamento-3); border-radius: var(--raio-controle);
      background: var(--ia-suave); color: var(--texto); font-size: 13px; }
    .falas { list-style: none; margin: 0; padding: var(--espacamento-2); display: grid; gap: var(--espacamento-2); max-height: 420px; overflow-y: auto;
      border: 1px solid var(--borda); border-radius: var(--raio-controle); background: var(--fundo); }
    .fala { display: grid; gap: 2px; max-width: 88%; padding: var(--espacamento-2) var(--espacamento-3); border-radius: var(--raio-painel);
      border: 1px solid var(--borda); background: var(--superficie); font-size: 13px; min-width: 0; }
    .fala[data-autor='sugestao'], .fala[data-autor='agente'] { justify-self: end; background: var(--acao-suave); border-color: var(--acao); }
    .fala[data-autor='humano'] { justify-self: end; background: transparent; border-style: dashed; color: var(--texto-secundario); }
    .autor { font-size: 11px; color: var(--texto-suave); text-transform: uppercase; letter-spacing: .02em; }
    .texto { overflow-wrap: anywhere; color: inherit; white-space: pre-wrap; }
    .violacoes { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--espacamento-1); }
    .violacoes li { display: flex; gap: var(--espacamento-2); align-items: baseline; flex-wrap: wrap; font-size: 13px; min-width: 0; }
    .trecho { color: var(--texto-secundario); overflow-wrap: anywhere; min-width: 0; flex: 1 1 200px; }
    .form { display: grid; gap: var(--espacamento-3); grid-template-columns: minmax(0, 1fr); min-width: 0; }
    .form-cab { display: flex; justify-content: space-between; align-items: baseline; gap: var(--espacamento-2); flex-wrap: wrap; }
    .criterio { border: 0; margin: 0; padding: 0; display: grid; gap: var(--espacamento-1); min-width: 0; }
    .c-nome { font-size: 13px; color: var(--texto); padding: 0; }
    .c-desc { margin: 0; font-size: 12px; color: var(--texto-suave); }
    .c-linha { display: flex; flex-wrap: wrap; gap: var(--espacamento-1) var(--espacamento-2); align-items: center; min-width: 0; }
    .c-linha .juiz { flex: 1 1 120px; }
    .vh { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
    .notas, .opcoes { display: inline-flex; flex-wrap: wrap; gap: 2px; }
    .n, .op { position: relative; display: inline-flex; align-items: center; justify-content: center; font-size: 13px; min-width: 32px; height: 32px;
      padding: 0 var(--espacamento-2); border: 1px solid var(--borda-controle); background: var(--superficie); color: var(--texto-secundario);
      border-radius: var(--raio-controle); cursor: pointer; }
    .n:hover, .op:hover { background: var(--superficie-hover); }
    .n.sel, .op.sel { border-color: var(--acao); background: var(--acao); color: var(--acao-texto); }
    .n.travado, .op.travado { cursor: default; opacity: .7; }
    .n:has(input:focus-visible), .op:has(input:focus-visible), .nav:focus-visible, .link:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 1px; }
    .juiz { display: flex; gap: var(--espacamento-1); align-items: baseline; min-width: 0; }
    .just { font-size: 12px; color: var(--texto-suave); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .grupo { border: 0; margin: 0; padding: 0; display: grid; gap: var(--espacamento-1); min-width: 0; }
    .grupo legend { font-size: 13px; color: var(--texto); margin-bottom: var(--espacamento-1); padding: 0; }
    .radio { display: flex; gap: var(--espacamento-2); align-items: center; font-size: 13px; color: var(--texto); cursor: pointer; }
    .campo { display: grid; gap: var(--espacamento-1); grid-template-columns: minmax(0, 1fr); min-width: 0; font-size: 13px; }
    .campo small { color: var(--texto-suave); font-size: 12px; }
    .campo select, .campo input, .campo textarea { font: inherit; min-width: 0; }
    .dupla { display: grid; grid-template-columns: 1fr 1fr; gap: var(--espacamento-3); }
    .msg-erro { color: var(--erro); font-size: 12px; }
    .resultado { margin: 0; font-size: 13px; padding: var(--espacamento-2) var(--espacamento-3); border-radius: var(--raio-controle); background: var(--superficie-hover); }
    .resultado[data-tom='sucesso'] { color: var(--sucesso); background: var(--sucesso-suave); }
    .resultado[data-tom='atencao'] { color: var(--atencao); background: var(--atencao-suave); }
    .acoes { display: flex; gap: var(--espacamento-2); flex-wrap: wrap; }
    .link { border: 0; background: transparent; padding: 0; font: inherit; font-size: 13px; color: var(--acao); cursor: pointer; text-decoration: underline; }
    @media (max-width: 640px) {
      .item { padding: var(--espacamento-2) var(--espacamento-3); }
      .criterios li { grid-template-columns: 1fr 52px; }
      .criterios .barra { grid-column: 1 / -1; grid-row: 2; }
      .numeros li { grid-template-columns: 1fr auto; }
      .dupla { grid-template-columns: 1fr; }
      .fala { max-width: 100%; }
    }
  `,
})
export class AgenteRevisaoComponente {
  /** Número selecionado na página. */
  readonly canalId = input.required<string>()

  readonly #api = inject(RevisaoServico)
  readonly #toast = inject(ToastServico)

  readonly criterios = CRITERIOS_RUBRICA
  readonly notas = NOTAS
  readonly gravidades = GRAVIDADES
  readonly vereditos = VEREDITOS_REVISAO
  readonly decisoes = DECISOES_REVISAO
  readonly meta = formatarPercentual(META_CONCORDANCIA)
  readonly minimo = MIN_REVISADAS_CONCORDANCIA

  readonly semana = signal(semanaDeHoje())
  readonly estado = signal<Estado>('carregando')
  readonly amostra = signal<AmostraRevisaoDto | null>(null)
  readonly concordancia = signal<ConcordanciaDto | null>(null)
  readonly exportando = signal(false)

  readonly aberto = signal<string | null>(null)
  readonly estadoDetalhe = signal<'carregando' | 'pronto' | 'erro'>('carregando')
  readonly detalhe = signal<DetalheRevisaoDto | null>(null)
  readonly form = signal<FormularioRevisao>(formularioVazio())
  readonly erros = signal<ErrosFormulario>({})
  /** Notas e gravidade ficam fixas depois da 1ª gravação (o servidor também não as muda). */
  readonly travado = computed(() => this.detalhe()?.revisao !== null && this.detalhe()?.revisao !== undefined)
  readonly salvando = signal(false)

  readonly itens = computed(() => this.amostra()?.itens ?? [])
  readonly progresso = computed(() => progressoDaAmostra(this.itens()))
  readonly ehSemanaAtual = computed(() => this.semana() >= semanaDeHoje())
  readonly rotuloDaSemana = computed(() => {
    const a = this.amostra()
    return a && a.semana === this.semana() ? rotuloSemana(a.semana, a.inicio) : `Semana ${Number(this.semana().slice(-2))}`
  })
  readonly semanaCurta = computed(() => `semana ${Number(this.semana().slice(-2))}`)
  readonly doNumero = computed(() => this.concordancia()?.porNumero.find((n) => n.canalId === this.canalId()) ?? (this.concordancia() ? VAZIA : null))
  readonly sit = computed(() => situacaoDaConcordancia(this.doNumero() ?? VAZIA))

  constructor() {
    effect(() => { this.canalId(); this.semana(); untracked(() => void this.carregar()) })
  }

  pct(f: number | null): string { return formatarPercentual(f) }
  largura(f: number | null): number { return f === null ? 0 : Math.round(f * 100) }
  nota(n: number | null): string { return formatarNota(n) }
  tomNota(n: number | null) { return tomDaNota(n) }
  grav(g: GravidadeQualidade | null | undefined): string { return rotuloGravidade(g ?? null) }
  badgeG(g: GravidadeQualidade) { return badgeGravidade(g) }
  motivo(i: ItemAmostraRevisaoDto): string { return rotuloMotivo(i.motivo) }
  situacaoDe(s: SomaConcordancia) { return situacaoDaConcordancia(s) }
  rotuloCriterio(c: CriterioRubrica): string { return ROTULO_CRITERIO[c] }
  descricao(c: CriterioRubrica): string { return DESCRICAO_CRITERIO[c] }
  rotuloVeredito(v: VereditoRevisao): string { return ROTULO_VEREDITO[v] }
  rotuloDecisao(d: DecisaoRevisao): string { return ROTULO_DECISAO[d] }
  violacao(v: DetalheRevisaoDto['violacoes'][number]): string {
    return v.regra ? linhaDaViolacao({ regra: v.regra, detalhe: v.detalhe ?? undefined, gravidade: v.gravidade ?? 'MEDIA', trecho: v.trecho }) : ''
  }
  resultado(r: NonNullable<ItemAmostraRevisaoDto['revisao']>) { return resultadoDaRevisao(r) }
  autor(f: FalaRevisao): string {
    return { cliente: 'Cliente', agente: 'Agente (enviou)', sugestao: 'Sugestão do agente', humano: 'Vendedor (contexto)' }[f.autor]
  }

  andar(delta: number): void {
    const s = deslocarSemana(this.semana(), delta)
    if (!s || (delta > 0 && s > semanaDeHoje())) return
    this.semana.set(s)
  }

  async carregar(): Promise<void> {
    this.estado.set('carregando'); this.aberto.set(null)
    try {
      this.amostra.set(await this.#api.amostra(this.canalId(), this.semana()))
      this.estado.set('pronto')
    } catch (e) {
      this.estado.set(ehSemPermissao(e) ? 'sem_permissao' : 'erro')
      return
    }
    await this.carregarConcordancia()
  }

  /** Secundário: falha vira aviso localizado (parcial), a amostra segue na tela. */
  async carregarConcordancia(): Promise<void> {
    try { this.concordancia.set(await this.#api.concordancia(this.semana())) } catch { this.concordancia.set(null) }
  }

  alternar(i: ItemAmostraRevisaoDto): void {
    if (this.aberto() === i.avaliacaoId) { this.aberto.set(null); return }
    void this.abrir(i)
  }

  async abrir(i: ItemAmostraRevisaoDto): Promise<void> {
    this.aberto.set(i.avaliacaoId); this.estadoDetalhe.set('carregando'); this.erros.set({})
    this.form.set(formularioDe(i.revisao)); this.detalhe.set(null)
    try {
      const d = await this.#api.detalhe(i.avaliacaoId)
      if (this.aberto() !== i.avaliacaoId) return
      this.detalhe.set(d); this.estadoDetalhe.set('pronto')
    } catch { if (this.aberto() === i.avaliacaoId) this.estadoDetalhe.set('erro') }
  }

  darNota(c: CriterioRubrica, n: number): void {
    this.form.update((f) => ({ ...f, notas: { ...f.notas, [c]: n } }))
    this.limparErro('notas')
  }

  campo<K extends keyof FormularioRevisao>(k: K, v: FormularioRevisao[K]): void {
    this.form.update((f) => ({ ...f, [k]: v }))
    this.limparErro(k)
  }

  idErro(campo: string): string { return `erro-revisao-${campo}` }

  limparErro(k: string): void {
    if (!(k in this.erros())) return
    this.erros.update((e) => Object.fromEntries(Object.entries(e).filter(([x]) => x !== k)) as ErrosFormulario)
  }

  async salvar(i: ItemAmostraRevisaoDto): Promise<void> {
    if (this.salvando()) return
    const c = corpoDoFormulario(i.avaliacaoId, this.form())
    if (!c.ok) { this.erros.set(c.erros); return }
    this.salvando.set(true)
    const r = await this.#api.gravar(c.corpo)
    this.salvando.set(false)
    if (!r.ok) {
      this.#toast.erro(mensagemDaFalhaRevisao(r.erro.erro, r.erro.mensagem ?? 'Não foi possível salvar a revisão.'))
      return
    }
    // A revisão volta para o item (estado "revisada") já sem venda — o servidor decide o que mostrar.
    this.amostra.update((a) => a && {
      ...a,
      itens: a.itens.map((x) => x.avaliacaoId === i.avaliacaoId
        ? { ...x, revisao: r.revisao, revisoes: x.revisao ? x.revisoes : x.revisoes + 1 }
        : x),
    })
    try { this.amostra.set(await this.#api.amostra(this.canalId(), this.semana())) } catch { /* fica a atualização local */ }
    this.form.set(formularioDe(r.revisao))
    // Agora o detalhe vem sem venda: notas e justificativas do juiz e gravidade das regras.
    try { this.detalhe.set(await this.#api.detalhe(r.revisao.avaliacaoId)) } catch { /* fica o que estava */ }
    this.#toast.sucesso('Revisão salva.')
    void this.carregarConcordancia()
  }

  async exportar(): Promise<void> {
    if (this.exportando()) return
    this.exportando.set(true)
    const r = await this.#api.planilha(this.canalId(), this.semana())
    this.exportando.set(false)
    if (!r.ok) {
      this.#toast.erro(mensagemDaFalhaRevisao(r.erro.erro, 'Não foi possível exportar a planilha agora.'))
      return
    }
    const url = URL.createObjectURL(r.blob)
    const link = document.createElement('a')
    link.href = url; link.download = r.nome
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    this.#toast.sucesso('Planilha da semana exportada.')
  }
}

const VAZIA: SomaConcordancia = somarConcordancia([])
