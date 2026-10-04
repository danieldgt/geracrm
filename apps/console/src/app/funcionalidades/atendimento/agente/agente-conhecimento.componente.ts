import { Component, ChangeDetectionStrategy, computed, effect, inject, input, signal, untracked } from '@angular/core'
import { DatePipe } from '@angular/common'
import {
  BadgeComponente, BotaoComponente, CampoComponente, ConfirmacaoServico, EsqueletoComponente, EstadoComponente,
  PainelComponente, ToastServico, mesclarPagina,
} from '../../../compartilhado/ui/index.js'
import { ehSemPermissao } from './agente.servico.js'
import { errosDoServidor } from './agente.regras.js'
import {
  ConhecimentoServico, type Documento, type ResultadoBusca, type TextoExtraido,
} from './conhecimento.servico.js'
import {
  ARQUIVO_MAX_BYTES, DESCRICAO_TIPO, LIMITES_DOCUMENTO, ROTULO_TIPO,
  ajustarTipoAoAlcance, arquivoGrande, badgeAlcance, badgeForca, badgeTipo, corpoDoDocumento, descreverMotivoSemantica,
  ehEspelhoDePoliticas, formularioDe, formularioNovo, motivoSemantica, resumoDaExtracao, rotuloFonte, rotuloSemantica,
  semanticaLigada, temPendentes, textoPendentes, tipoArquivoDe, tiposDisponiveis, validarDocumento,
  type Alcance, type CapacidadesBusca, type FormularioDocumento, type TipoDocumento,
} from './conhecimento.regras.js'

type Estado = 'carregando' | 'pronto' | 'erro' | 'sem_permissao'
/** O painel de capacidade carrega à parte: se falhar, a lista segue de pé (parcial). */
type EstadoCap = 'carregando' | 'pronto' | 'erro'

interface Importado extends TextoExtraido { readonly nome: string }

/**
 * A BASE DE CONHECIMENTO como produto (ADR-026): o que o agente pode citar
 * além do catálogo. Documentos globais e deste número, com versão; importar
 * arquivo para REVISAR antes de salvar; e "testar a base" — o que o robô
 * acharia se o cliente perguntasse X.
 *
 * ⚠️ A degradação é VISÍVEL: o painel do topo diz se a busca é só lexical ou
 * lexical + semântica, e por quê (nomeando a variável que falta). Falha ao
 * embutir é aviso localizado; a lista nunca cai junto.
 *
 * ⚠️ O documento 'politicas' de um número espelha a aba Configuração: aparece
 * com selo e não muda de tipo nem de alcance (a API recusa; a tela desabilita).
 */
@Component({
  selector: 'app-agente-conhecimento',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, BadgeComponente, BotaoComponente, CampoComponente, EsqueletoComponente, EstadoComponente, PainelComponente],
  template: `
    <div class="conhecimento">

      <!-- (a) Capacidade da busca — do tenant, não do número. -->
      <ui-painel>
        <div class="cap">
          @switch (estadoCap()) {
            @case ('carregando') { <ui-esqueleto altura="24px" largura="260px" /> }
            @case ('erro') {
              <p class="dica aviso-inline">Não foi possível ler o estado da busca.
                <button type="button" class="link" (click)="carregarCapacidades()">Tentar de novo</button></p>
            }
            @case ('pronto') {
              @if (cap(); as k) {
                <div class="cap-linha">
                  <ui-badge [tom]="ligada() ? 'sucesso' : 'neutro'">{{ rotuloBusca() }}</ui-badge>
                  @if (motivoCap(); as m) { <span class="cap-motivo">semântica desligada — <span class="txt-dados">{{ m }}</span></span> }
                  @if (ligada()) {
                    <span class="txt-dados cap-pend">{{ pendentes(k) }}</span>
                    @if (haPendentes()) {
                      <ui-botao variante="secundario" [carregando]="embutindo()" (click)="embutir()">
                        {{ embutindo() ? 'Embutindo…' : 'Embutir agora' }}</ui-botao>
                    }
                  }
                </div>
                <p class="dica">{{ ligada()
                  ? 'Além das palavras, o agente acha trechos pelo sentido. Trechos novos são embutidos sozinhos a cada minuto; o botão adianta.'
                  : 'O agente acha trechos pelas palavras e por aproximação de grafia. Perguntas com outras palavras podem não achar.' }}</p>
                @if (avisoCap(); as a) { <p class="aviso aviso--erro" role="alert">{{ a }}</p> }
              }
            }
          }
        </div>
      </ui-painel>

      <!-- (b) Formulário criar/editar — painel que abre; preserva o texto digitado. -->
      @if (form(); as f) {
        <ui-painel>
          <form class="form" (submit)="salvar($event)" novalidate>
            <div class="form-cab">
              <h2 class="txt-secao secao">{{ f.id ? 'Editar documento' : 'Novo documento' }}</h2>
              @if (espelhoEmEdicao()) { <ui-badge tom="info">espelha a Configuração</ui-badge> }
            </div>
            @if (erroGeral(); as g) { <div class="aviso aviso--erro" role="alert">{{ g }}</div> }

            <ui-campo rotulo="Título" [valor]="f.titulo" (valorChange)="mudar('titulo', $event)" [erro]="erroDe('titulo')"
                      placeholder="Ex.: Prazos de entrega por região" />

            <div class="grade-2">
              <label class="campo">
                <span>Tipo</span>
                <select [value]="f.tipo" [disabled]="espelhoEmEdicao()" (change)="mudarTipo($any($event.target).value)"
                        [attr.aria-invalid]="erroDe('tipo') ? 'true' : null">
                  @for (t of tipos(); track t) { <option [value]="t">{{ rotuloTipo[t] }}</option> }
                </select>
                @if (erroDe('tipo'); as e) { <span class="msg-erro">{{ e }}</span> }
                <small>{{ descricaoTipo[f.tipo] }}</small>
              </label>

              <fieldset class="alcance" [disabled]="espelhoEmEdicao()">
                <legend class="campo-rotulo">Vale para</legend>
                <label class="radio">
                  <input type="radio" name="alcance" value="global" [checked]="f.alcance === 'global'" (change)="mudarAlcance('global')" />
                  Todos os números
                </label>
                <label class="radio" [class.off]="!canalId()">
                  <input type="radio" name="alcance" value="canal" [checked]="f.alcance === 'canal'" [disabled]="!canalId()"
                         (change)="mudarAlcance('canal')" />
                  Só este número
                </label>
                @if (erroDe('canalId'); as e) { <span class="msg-erro">{{ e }}</span> }
                <small>Políticas de um número se escrevem na aba Configuração — a base espelha de lá. Aqui só entram políticas que valem para todos.</small>
              </fieldset>
            </div>

            <label class="campo">
              <span>Conteúdo</span>
              <textarea rows="14" [value]="f.conteudo" (input)="mudar('conteudo', $any($event.target).value)"
                        [attr.aria-invalid]="erroDe('conteudo') ? 'true' : null"
                        placeholder="Escreva como explicaria a um cliente. Títulos e parágrafos curtos ajudam o agente a citar o trecho certo."></textarea>
              @if (erroDe('conteudo'); as e) { <span class="msg-erro">{{ e }}</span> }
              <small class="contador txt-dados">{{ f.conteudo.length }} / {{ limites.conteudoMax }}</small>
            </label>

            <!-- Importar arquivo: o texto vem para REVISÃO; nada é salvo sem o clique em Salvar. -->
            <div class="importar">
              <label class="btn btn--secundario importar-btn" [class.off]="importando()">
                <input type="file" class="sr" accept=".txt,.md,.markdown,.pdf" [disabled]="importando()" (change)="importar($event)" />
                {{ importando() ? 'Lendo arquivo…' : 'Importar arquivo (.txt, .md, .pdf)' }}
              </label>
              <span class="dica">O texto do arquivo substitui o conteúdo acima para você revisar. Só salva quando clicar em Salvar.</span>
            </div>
            @if (erroImportar(); as e) { <p class="aviso aviso--erro" role="alert">{{ e }}</p> }
            @if (importado(); as i) {
              <div class="aviso importado" role="status">
                <span>Importado de <span class="txt-dados">{{ i.nome }}</span> — {{ resumoImportado(i) }}. Revise antes de salvar.</span>
                @if (i.avisos.length > 0) {
                  <ul>@for (a of i.avisos; track $index) { <li>{{ a }}</li> }</ul>
                }
              </div>
            }

            <div class="acoes">
              <ui-botao tipo="submit" [carregando]="salvando()">{{ salvando() ? 'Salvando…' : 'Salvar' }}</ui-botao>
              <ui-botao variante="fantasma" [desabilitado]="salvando()" (click)="fecharForm()">Cancelar</ui-botao>
              @if (temErros()) { <span class="msg-erro">Corrija os campos destacados.</span> }
            </div>
          </form>
        </ui-painel>
      }

      <!-- (c) Lista por cursor -->
      @switch (estado()) {
        @case ('carregando') {
          <ui-painel><div class="esq-lista">
            <ui-esqueleto altura="20px" largura="40%" />
            <ui-esqueleto altura="56px" /><ui-esqueleto altura="56px" /><ui-esqueleto altura="56px" />
          </div></ui-painel>
        }
        @case ('sem_permissao') {
          <ui-painel><ui-estado tipo="sem-permissao" titulo="Sem acesso à base de conhecimento"
            descricao="Peça a um administrador para liberar." /></ui-painel>
        }
        @case ('erro') {
          <ui-painel><ui-estado tipo="erro" titulo="Não foi possível carregar os documentos"
            descricao="O servidor não respondeu. Dá para tentar de novo.">
            <ui-botao variante="secundario" (click)="carregar()">Tentar de novo</ui-botao>
          </ui-estado></ui-painel>
        }
        @case ('pronto') {
          <div class="barra">
            <label class="chk">
              <input type="checkbox" [checked]="incluirDespublicados()" (change)="alternarDespublicados($any($event.target).checked)" />
              Incluir despublicados
            </label>
            @if (!form()) { <ui-botao (click)="novo()">Novo documento</ui-botao> }
          </div>

          @if (itens().length === 0) {
            <ui-painel><ui-estado titulo="Nenhum documento ainda" icone="📚"
              descricao="O agente só responde o que estiver aqui ou nas políticas. Comece pelo que os clientes mais perguntam: frete, pagamento, troca.">
              @if (!form()) { <ui-botao (click)="novo()">Novo documento</ui-botao> }
            </ui-estado></ui-painel>
          } @else {
            <ul class="lista">
              @for (d of itens(); track d.id) {
                <li class="item" [class.despublicado]="!d.publicado">
                  <!-- Badges em ORDEM FIXA: tipo, alcance, versão, trechos, estado, espelho. -->
                  <div class="linha">
                    <span class="titulo encolhe">{{ d.titulo }}</span>
                    <ui-badge [tom]="tipo(d.tipo).tom">{{ tipo(d.tipo).rotulo }}</ui-badge>
                    <ui-badge [tom]="alcance(d).tom">{{ alcance(d).rotulo }}</ui-badge>
                    <span class="txt-dados meta">v{{ d.versao }}</span>
                    <span class="txt-dados meta">{{ d.trechos }} {{ d.trechos === 1 ? 'trecho' : 'trechos' }}</span>
                    @if (!d.publicado) { <ui-badge tom="atencao">despublicado</ui-badge> }
                    @if (espelho(d)) { <ui-badge tom="info">espelha a Configuração</ui-badge> }
                  </div>
                  <p class="previa">{{ d.conteudo }}</p>
                  <div class="rodape">
                    <span class="txt-dados quando">atualizado {{ d.atualizadoEm | date: 'dd/MM HH:mm' }}</span>
                    <div class="acoes-item">
                      <ui-botao variante="fantasma" [desabilitado]="acaoEm() !== null" (click)="editar(d)">Editar</ui-botao>
                      @if (d.publicado) {
                        <ui-botao variante="fantasma" [carregando]="acaoEm() === d.id" [desabilitado]="acaoEm() !== null && acaoEm() !== d.id"
                                  (click)="despublicar(d)">Despublicar</ui-botao>
                      } @else {
                        <ui-botao variante="secundario" [carregando]="acaoEm() === d.id" [desabilitado]="acaoEm() !== null && acaoEm() !== d.id"
                                  (click)="publicar(d)">Publicar</ui-botao>
                      }
                    </div>
                  </div>
                </li>
              }
            </ul>
            @if (erroMais(); as e) { <p class="erro-mais" role="alert">{{ e }}</p> }
            @if (proximoCursor()) {
              <div class="mais">
                <ui-botao variante="secundario" (click)="carregarMais()" [carregando]="carregandoMais()">
                  {{ carregandoMais() ? 'Carregando…' : 'Carregar mais' }}</ui-botao>
              </div>
            }
          }

          <!-- (d) Testar a base: o que o agente receberia para esta pergunta. -->
          <ui-painel>
            <h2 class="txt-secao secao">Testar a base</h2>
            <p class="dica topo">Pergunte como um cliente perguntaria. Aparecem os trechos que o agente receberia, com a fonte e a versão.</p>
            <form class="busca" (submit)="buscar($event)" novalidate>
              <label class="sr" for="kb-pergunta">Pergunta</label>
              <input id="kb-pergunta" class="busca-campo" type="search" [value]="pergunta()" (input)="pergunta.set($any($event.target).value)"
                     placeholder="Ex.: vocês entregam em Recife? qual o prazo?" maxlength="300" [disabled]="buscando()" />
              <ui-botao tipo="submit" [desabilitado]="!podeBuscar()" [carregando]="buscando()">Buscar</ui-botao>
            </form>
            @if (erroBusca(); as e) { <p class="aviso aviso--erro" role="alert">{{ e }}</p> }
            @if (busca(); as b) {
              <div class="pernas">
                <span class="dica">Pernas usadas: <span class="txt-dados">{{ pernas(b) }}</span></span>
                @if (motivoBusca(b); as m) { <span class="dica">semântica desligada: <span class="txt-dados">{{ m }}</span></span> }
              </div>
              @if (b.trechos.length === 0) {
                <ui-estado titulo="Nenhum trecho encontrado" icone="🔍"
                  descricao="Escreva um documento sobre isso ou reformule a pergunta." />
              } @else {
                <ol class="trechos">
                  @for (t of b.trechos; track $index) {
                    <li class="trecho">
                      <!-- Ordem fixa: título vN, tipo, fontes, força. -->
                      <div class="linha">
                        <span class="titulo encolhe">{{ t.titulo }} <span class="txt-dados meta">v{{ t.versao }}</span></span>
                        <ui-badge [tom]="tipo(t.tipo).tom">{{ tipo(t.tipo).rotulo }}</ui-badge>
                        @for (f of t.fontes; track f) { <span class="chip">{{ fonte(f) }}</span> }
                        <ui-badge [tom]="forca(t.score).tom">{{ forca(t.score).rotulo }}</ui-badge>
                      </div>
                      <p class="texto">{{ t.texto }}</p>
                    </li>
                  }
                </ol>
              }
            }
          </ui-painel>
        }
      }
    </div>
  `,
  styles: `
    :host { display: block; min-width: 0; }
    .conhecimento { display: grid; gap: var(--espacamento-4); min-width: 0; }
    .esq-lista { display: grid; gap: var(--espacamento-2); }
    .secao { margin: 0 0 var(--espacamento-3); color: var(--texto); }
    .topo { margin-top: 0; }
    .dica { margin: var(--espacamento-1) 0 0; color: var(--texto-suave); font-size: 12px; }
    .link { border: 0; background: transparent; padding: 0; font: inherit; color: var(--acao); cursor: pointer; text-decoration: underline; }
    .link:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; border-radius: var(--raio-controle); }

    .cap { display: grid; gap: var(--espacamento-1); min-width: 0; }
    .cap-linha { display: flex; align-items: center; gap: var(--espacamento-3); flex-wrap: wrap; min-width: 0; }
    .cap-motivo { color: var(--atencao); font-size: 13px; overflow-wrap: anywhere; }
    .cap-pend { color: var(--texto-secundario); }
    .aviso-inline { margin: 0; display: flex; gap: var(--espacamento-2); flex-wrap: wrap; }

    .form { display: grid; gap: var(--espacamento-3); min-width: 0; }
    .form-cab { display: flex; align-items: center; gap: var(--espacamento-2); flex-wrap: wrap; }
    .form-cab .secao { margin: 0; }
    .grade-2 { display: grid; gap: var(--espacamento-3); grid-template-columns: 1fr 1fr; min-width: 0; }
    .grade-2 > * { min-width: 0; }
    .campo input, .campo select, .campo textarea { font: inherit; width: 100%; min-height: var(--densidade-alvo-clique-console); }
    .campo textarea { min-height: 0; font-family: inherit; line-height: 1.45; }
    .campo input:focus-visible, .campo select:focus-visible, .campo textarea:focus-visible {
      outline: none; border-color: var(--borda-foco); box-shadow: 0 0 0 2px var(--borda-foco); }
    .campo [aria-invalid='true'] { border-color: var(--borda-erro); }
    .campo select:disabled { opacity: .6; }
    .contador { color: var(--texto-suave); justify-self: end; }
    .msg-erro { font-size: 12px; color: var(--erro); }
    .alcance { margin: 0; padding: 0; border: 0; min-width: 0; display: grid; gap: var(--espacamento-1); }
    .alcance:disabled { opacity: .6; }
    .campo-rotulo { padding: 0; font-size: 12px; font-weight: 500; color: var(--texto-secundario); }
    .alcance small { font-size: 11px; color: var(--texto-suave); }
    .radio { display: flex; align-items: center; gap: var(--espacamento-2); color: var(--texto); font-size: 14px; cursor: pointer; }
    .radio.off { opacity: .55; cursor: default; }
    .radio input { flex: none; }
    .importar { display: flex; align-items: center; gap: var(--espacamento-3); flex-wrap: wrap; }
    .importar-btn { cursor: pointer; display: inline-flex; align-items: center; }
    .importar-btn.off { opacity: .55; cursor: default; }
    .importar-btn:has(input:focus-visible) { outline: 2px solid var(--borda-foco); outline-offset: 2px; }
    .importar .dica { margin: 0; flex: 1 1 240px; }
    .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    .aviso { margin: 0; padding: var(--espacamento-2) var(--espacamento-3); border-radius: var(--raio-controle);
      background: var(--atencao-suave); color: var(--texto); font-size: 13px; }
    .aviso--erro { background: var(--erro-suave); }
    .importado { background: var(--sucesso-suave); display: grid; gap: var(--espacamento-1); }
    .aviso ul { margin: 0; padding-left: var(--espacamento-4); display: grid; gap: 2px; }
    .acoes { display: flex; align-items: center; gap: var(--espacamento-2); flex-wrap: wrap; }

    .barra { display: flex; align-items: center; justify-content: space-between; gap: var(--espacamento-3); flex-wrap: wrap; }
    .chk { display: flex; align-items: center; gap: var(--espacamento-2); color: var(--texto); font-size: 14px; cursor: pointer; }
    .chk input { flex: none; }
    .lista { list-style: none; margin: 0; padding: 0; border: 1px solid var(--borda); border-radius: var(--raio-painel);
      background: var(--superficie-elevada); overflow: hidden; }
    .item { padding: var(--espacamento-3) var(--espacamento-4); border-bottom: 1px solid var(--borda); display: grid;
      gap: var(--espacamento-1); min-width: 0; }
    .item:last-child { border-bottom: none; }
    .item.despublicado .titulo, .item.despublicado .previa { color: var(--texto-suave); }
    .linha { display: flex; align-items: center; gap: var(--espacamento-2); flex-wrap: wrap; min-width: 0; }
    .titulo { color: var(--texto); font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      flex: 1 1 160px; }
    .meta { color: var(--texto-suave); }
    .previa { margin: 0; color: var(--texto-secundario); font-size: 13px; overflow: hidden; display: -webkit-box;
      -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
    .rodape { display: flex; align-items: center; justify-content: space-between; gap: var(--espacamento-2); flex-wrap: wrap; }
    .quando { color: var(--texto-suave); }
    .acoes-item { display: flex; gap: var(--espacamento-1); flex-wrap: wrap; }
    .erro-mais { margin: 0; color: var(--erro); font-size: 13px; }
    .mais { display: flex; }

    .busca { display: flex; gap: var(--espacamento-2); align-items: center; min-width: 0; }
    .busca-campo { flex: 1; min-width: 0; padding: var(--espacamento-2) var(--espacamento-3); font: inherit;
      border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto);
      min-height: var(--densidade-alvo-clique-console); }
    .busca-campo:focus-visible { outline: none; border-color: var(--borda-foco); box-shadow: 0 0 0 2px var(--borda-foco); }
    .pernas { display: flex; gap: var(--espacamento-4); flex-wrap: wrap; margin-top: var(--espacamento-3); }
    .trechos { list-style: none; margin: var(--espacamento-3) 0 0; padding: 0; display: grid; gap: var(--espacamento-2); }
    .trecho { padding: var(--espacamento-3); border: 1px solid var(--borda); border-radius: var(--raio-controle);
      background: var(--superficie); display: grid; gap: var(--espacamento-1); min-width: 0; }
    .chip { font-size: 11px; padding: 2px 8px; border-radius: var(--raio-completo); background: var(--acao-suave); color: var(--texto-secundario);
      white-space: nowrap; }
    .texto { margin: 0; color: var(--texto); font-size: 13px; white-space: pre-wrap; overflow-wrap: anywhere; }
    @media (max-width: 640px) { .grade-2 { grid-template-columns: 1fr; } .busca { flex-wrap: wrap; } .item { padding: var(--espacamento-3); } }
  `,
})
export class AgenteConhecimentoComponente {
  readonly canalId = input.required<string>()

  private readonly api = inject(ConhecimentoServico)
  private readonly toast = inject(ToastServico)
  private readonly confirmacao = inject(ConfirmacaoServico)

  readonly rotuloTipo = ROTULO_TIPO
  readonly descricaoTipo = DESCRICAO_TIPO
  readonly limites = LIMITES_DOCUMENTO

  // ─── Lista ───
  readonly estado = signal<Estado>('carregando')
  readonly itens = signal<readonly Documento[]>([])
  readonly proximoCursor = signal<string | null>(null)
  readonly carregandoMais = signal(false)
  /** ⚠️ Parcial: a primeira página está na tela; "carregar mais" falhou. */
  readonly erroMais = signal<string | null>(null)
  readonly incluirDespublicados = signal(false)
  /** Id do documento com publicar/despublicar em andamento. */
  readonly acaoEm = signal<string | null>(null)

  // ─── Capacidade ───
  readonly estadoCap = signal<EstadoCap>('carregando')
  readonly cap = signal<CapacidadesBusca | null>(null)
  readonly embutindo = signal(false)
  readonly avisoCap = signal<string | null>(null)
  readonly ligada = computed(() => { const k = this.cap(); return k ? semanticaLigada(k) : false })
  readonly rotuloBusca = computed(() => { const k = this.cap(); return k ? rotuloSemantica(k) : '' })
  readonly motivoCap = computed(() => { const k = this.cap(); return k ? motivoSemantica(k) : null })
  readonly haPendentes = computed(() => { const k = this.cap(); return k ? temPendentes(k) : false })

  // ─── Formulário ───
  /** `null` = fechado. Um signal com o formulário inteiro: campos validados e salvos JUNTOS. */
  readonly form = signal<FormularioDocumento | null>(null)
  readonly salvando = signal(false)
  private readonly tentou = signal(false)
  private readonly errosServidor = signal<Readonly<Record<string, string>>>({})
  readonly erroGeral = signal<string | null>(null)
  readonly importando = signal(false)
  readonly importado = signal<Importado | null>(null)
  readonly erroImportar = signal<string | null>(null)
  /** O documento em edição é o espelho das políticas do número? Então tipo e alcance ficam travados. */
  readonly espelhoEmEdicao = computed(() => {
    const f = this.form()
    if (!f?.id) return false
    const d = this.itens().find((x) => x.id === f.id)
    return d ? ehEspelhoDePoliticas(d) : false
  })
  readonly tipos = computed<readonly TipoDocumento[]>(() => {
    const f = this.form()
    if (!f) return []
    // Em edição do espelho a lista precisa conter 'politicas' para o select mostrar o valor.
    return this.espelhoEmEdicao() ? [...tiposDisponiveis('global')] : tiposDisponiveis(f.alcance)
  })
  private readonly errosLocais = computed(() => {
    const f = this.form()
    return f && this.tentou() ? validarDocumento(f) : {}
  })
  readonly temErros = computed(() => Object.keys(this.errosLocais()).length > 0 || Object.keys(this.errosServidor()).length > 0)

  // ─── Testar a base ───
  readonly pergunta = signal('')
  readonly buscando = signal(false)
  readonly busca = signal<ResultadoBusca | null>(null)
  readonly erroBusca = signal<string | null>(null)
  readonly podeBuscar = computed(() => !this.buscando() && this.pergunta().trim().length > 0)

  constructor() {
    // Trocar de número recarrega a lista e zera o que era daquele número (form, busca).
    effect(() => {
      this.canalId()
      untracked(() => { this.fecharForm(); this.busca.set(null); this.erroBusca.set(null); void this.carregar() })
    })
    // A capacidade é do servidor/tenant: uma carga por tela.
    void this.carregarCapacidades()
  }

  tipo(t: string) { return badgeTipo(t) }
  alcance(d: Documento) { return badgeAlcance(d) }
  espelho(d: Documento): boolean { return ehEspelhoDePoliticas(d) }
  forca(score: number) { return badgeForca(score) }
  fonte(f: string): string { return rotuloFonte(f) }
  pendentes(k: CapacidadesBusca): string { return textoPendentes(k) }
  resumoImportado(i: Importado): string { return resumoDaExtracao(i) }
  pernas(b: ResultadoBusca): string { return b.fontes.length > 0 ? b.fontes.map(rotuloFonte).join(', ') : 'nenhuma' }
  motivoBusca(b: ResultadoBusca): string | null { return descreverMotivoSemantica(b.semantica, this.cap()?.embedding.falta ?? null) }
  erroDe(campo: string): string | null { return this.errosServidor()[campo] ?? this.errosLocais()[campo] ?? null }

  // ─── Capacidade ───

  async carregarCapacidades(): Promise<void> {
    this.estadoCap.set('carregando'); this.avisoCap.set(null)
    try {
      this.cap.set(await this.api.capacidades())
      this.estadoCap.set('pronto')
    } catch {
      // ⚠️ Parcial: a lista segue; só o painel mostra "tentar de novo".
      this.estadoCap.set('erro')
    }
  }

  async embutir(): Promise<void> {
    if (this.embutindo()) return
    this.embutindo.set(true); this.avisoCap.set(null)
    try {
      const r = await this.api.embutir()
      if (r.ok) {
        const { produtos, trechos, restantes } = r.resultado
        const resto = restantes.trechos + restantes.produtos
        this.toast.sucesso(`Embutidos ${trechos} trechos e ${produtos} produtos${resto > 0 ? ` — ${resto} ainda pendentes, o servidor continua` : ''}.`)
        await this.carregarCapacidades()
        return
      }
      if (r.status === 403) { this.avisoCap.set('Você não tem permissão para embutir.'); return }
      if (r.status === 409) {
        const motivo = descreverMotivoSemantica(r.erro.semantica ?? 'sem_chave', this.cap()?.embedding.falta ?? null)
        this.avisoCap.set(`A semântica está desligada neste servidor — ${motivo ?? 'motivo não informado'}. Nada foi embutido.`)
        await this.carregarCapacidades()
        return
      }
      if (r.status === 502) {
        this.avisoCap.set(`O fornecedor de embedding falhou (${r.erro.codigo ?? 'erro'}). O servidor tenta de novo no próximo ciclo; dá para clicar outra vez em um minuto.`)
        return
      }
      this.avisoCap.set(r.erro.mensagem ?? 'Não foi possível embutir agora.')
    } finally { this.embutindo.set(false) }
  }

  // ─── Lista ───

  async carregar(): Promise<void> {
    this.estado.set('carregando'); this.erroMais.set(null)
    try {
      const p = await this.api.listar({ cursor: null, canalId: this.canalId(), incluirDespublicados: this.incluirDespublicados() })
      this.itens.set(p.itens)
      this.proximoCursor.set(p.proximoCursor)
      this.estado.set('pronto')
    } catch (e) {
      this.estado.set(ehSemPermissao(e) ? 'sem_permissao' : 'erro')
    }
  }

  async carregarMais(): Promise<void> {
    const cursor = this.proximoCursor()
    if (!cursor || this.carregandoMais()) return
    this.carregandoMais.set(true); this.erroMais.set(null)
    try {
      const p = await this.api.listar({ cursor, canalId: this.canalId(), incluirDespublicados: this.incluirDespublicados() })
      this.itens.update((a) => mesclarPagina(a, p.itens, (d) => d.id))
      this.proximoCursor.set(p.proximoCursor)
    } catch {
      this.erroMais.set('Não foi possível carregar mais documentos. Tente de novo.')
    } finally { this.carregandoMais.set(false) }
  }

  alternarDespublicados(ligado: boolean): void {
    this.incluirDespublicados.set(ligado)
    void this.carregar()
  }

  async publicar(d: Documento): Promise<void> {
    if (this.acaoEm()) return
    this.acaoEm.set(d.id)
    try {
      const r = await this.api.editar(d.id, { publicado: true })
      if (r.ok) {
        this.toast.sucesso(`"${d.titulo}" publicado — o agente volta a usar.`)
        this.substituir(r.documento)
        return
      }
      this.falhaDeAcao(r.status, r.erro.mensagem, 'Não foi possível publicar.')
    } finally { this.acaoEm.set(null) }
  }

  async despublicar(d: Documento): Promise<void> {
    if (this.acaoEm()) return
    const ok = await this.confirmacao.confirmar({
      titulo: `Despublicar "${d.titulo}"?`,
      mensagem: 'O agente deixa de usar este texto nas respostas. Ele fica guardado e pode ser publicado de novo quando quiser.',
      acao: 'Despublicar', perigo: true,
    })
    if (!ok) return
    this.acaoEm.set(d.id)
    try {
      const r = await this.api.despublicar(d.id)
      if (r.ok) {
        this.toast.sucesso(`"${d.titulo}" despublicado.`)
        if (this.incluirDespublicados()) this.substituir({ ...d, publicado: false })
        else this.itens.update((a) => a.filter((x) => x.id !== d.id))
        return
      }
      this.falhaDeAcao(r.status, r.erro.mensagem, 'Não foi possível despublicar.')
    } finally { this.acaoEm.set(null) }
  }

  private substituir(doc: Documento): void {
    this.itens.update((a) => a.map((x) => (x.id === doc.id ? doc : x)))
  }

  private falhaDeAcao(status: number, mensagem: string | undefined, padrao: string): void {
    if (status === 403) { this.estado.set('sem_permissao'); return }
    if (status === 404) {
      this.toast.erro('Este documento não existe mais. A lista foi recarregada.')
      void this.carregar()
      return
    }
    this.toast.erro(mensagem ?? padrao)
  }

  // ─── Formulário ───

  novo(): void {
    this.abrirForm(formularioNovo(this.canalId()))
  }

  editar(d: Documento): void {
    this.abrirForm(formularioDe(d))
  }

  private abrirForm(f: FormularioDocumento): void {
    this.form.set(f)
    this.tentou.set(false); this.errosServidor.set({}); this.erroGeral.set(null)
    this.importado.set(null); this.erroImportar.set(null)
  }

  fecharForm(): void {
    this.form.set(null)
    this.tentou.set(false); this.errosServidor.set({}); this.erroGeral.set(null)
    this.importado.set(null); this.erroImportar.set(null)
  }

  mudar<K extends 'titulo' | 'conteudo'>(campo: K, valor: FormularioDocumento[K]): void {
    this.form.update((f) => (f ? { ...f, [campo]: valor } : f))
    this.limparErro(campo)
  }

  mudarTipo(tipo: string): void {
    const f = this.form()
    if (!f) return
    const t = this.tipos().includes(tipo as TipoDocumento) ? (tipo as TipoDocumento) : f.tipo
    this.form.set({ ...f, tipo: t })
    this.limparErro('tipo')
  }

  mudarAlcance(alcance: Alcance): void {
    const f = this.form()
    if (!f) return
    this.form.set({ ...f, alcance, tipo: ajustarTipoAoAlcance(f.tipo, alcance) })
    this.limparErro('canalId'); this.limparErro('tipo')
  }

  private limparErro(campo: string): void {
    if (!(campo in this.errosServidor())) return
    this.errosServidor.update((e) => { const n = { ...e }; delete n[campo]; return n })
  }

  /** Lê o arquivo no navegador, manda para a API extrair e PREENCHE o conteúdo — a pessoa revisa e salva. */
  async importar(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement
    const arquivo = input.files?.[0]
    input.value = ''
    if (!arquivo || this.importando()) return
    this.erroImportar.set(null); this.importado.set(null)
    const tipo = tipoArquivoDe(arquivo.name, arquivo.type)
    if (!tipo) { this.erroImportar.set('Formato não aceito. Use .txt, .md ou .pdf.'); return }
    if (arquivoGrande(arquivo.size)) {
      this.erroImportar.set(`Arquivo acima de ${Math.round(ARQUIVO_MAX_BYTES / 1024 / 1024)} MB. Divida ou exporte só o texto.`)
      return
    }
    this.importando.set(true)
    try {
      const conteudoBase64 = await lerBase64(arquivo)
      const r = await this.api.extrair({ nome: arquivo.name, tipo, conteudoBase64 })
      if (!r.ok) {
        if (r.status === 403) { this.erroImportar.set('Você não tem permissão para importar.'); return }
        this.erroImportar.set(r.erro.mensagem ?? 'Não foi possível ler o arquivo.')
        return
      }
      this.form.update((f) => (f ? { ...f, conteudo: r.texto.texto, titulo: f.titulo || tituloDoArquivo(arquivo.name) } : f))
      this.importado.set({ ...r.texto, nome: arquivo.name })
      this.limparErro('conteudo')
    } catch {
      this.erroImportar.set('Não foi possível ler o arquivo no navegador. Tente de novo.')
    } finally { this.importando.set(false) }
  }

  async salvar(ev: Event): Promise<void> {
    ev.preventDefault()
    const f = this.form()
    if (!f || this.salvando()) return
    this.tentou.set(true); this.errosServidor.set({}); this.erroGeral.set(null)
    if (Object.keys(validarDocumento(f)).length > 0) {
      this.toast.erro('Corrija os campos destacados antes de salvar.')
      return
    }
    this.salvando.set(true)
    try {
      const corpo = corpoDoDocumento(f, this.canalId())
      // O espelho não manda tipo nem canalId: a API recusaria qualquer mudança neles.
      const r = f.id
        ? await this.api.editar(f.id, this.espelhoEmEdicao() ? { titulo: corpo.titulo, conteudo: corpo.conteudo } : corpo)
        : await this.api.criar(corpo)
      if (r.ok) {
        this.toast.sucesso(f.id ? `"${r.documento.titulo}" salvo — agora na v${r.documento.versao}.` : `"${r.documento.titulo}" criado e publicado.`)
        this.fecharForm()
        await this.carregar()
        return
      }
      if (r.status === 403) { this.estado.set('sem_permissao'); return }
      if (r.status === 404) { this.erroGeral.set('Este documento não existe mais. Feche o formulário e recarregue a lista.'); return }
      const mapeado = errosDoServidor(r.erro)
      this.errosServidor.set(mapeado.campos)
      this.erroGeral.set(mapeado.geral)
      this.toast.erro(mapeado.geral ?? 'Não foi possível salvar — veja os campos destacados.')
    } finally { this.salvando.set(false) }
  }

  // ─── Testar a base ───

  async buscar(ev: Event): Promise<void> {
    ev.preventDefault()
    const pergunta = this.pergunta().trim()
    if (!pergunta || this.buscando()) return
    this.buscando.set(true); this.erroBusca.set(null)
    try {
      const r = await this.api.buscar(pergunta, this.canalId())
      if (r.ok) { this.busca.set(r.resultado); return }
      if (r.status === 403) { this.estado.set('sem_permissao'); return }
      this.erroBusca.set(r.erro.mensagem ?? 'Não foi possível testar a base agora.')
    } finally { this.buscando.set(false) }
  }
}

/** FileReader → base64 puro (sem o prefixo data:). */
function lerBase64(arquivo: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const leitor = new FileReader()
    leitor.onload = () => resolve(String(leitor.result ?? '').replace(/^data:[^,]*,/, ''))
    leitor.onerror = () => reject(leitor.error ?? new Error('leitura falhou'))
    leitor.readAsDataURL(arquivo)
  })
}

/** "politicas-de-frete.pdf" → "politicas-de-frete" — sugestão de título quando o campo está vazio. */
function tituloDoArquivo(nome: string): string {
  const ponto = nome.lastIndexOf('.')
  return (ponto > 0 ? nome.slice(0, ponto) : nome).slice(0, LIMITES_DOCUMENTO.tituloMax)
}
