import { DatePipe } from '@angular/common'
import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core'
import { compararConferencia, type DePara, type TipoImportacao } from '@geracrm/shared'
import {
  AbasComponente, BadgeComponente, CabecalhoTelaComponente, CelulaDiretiva, ConfirmacaoServico, EstadoComponente, FormPaginaComponente,
  GradeFormComponente, PaginacaoComponente, SecaoFormComponente, SelectComponente, StatCardComponente, TabelaComponente, ToastServico,
  codigoDoErro, corpoDoErro, ehStatus, mensagemDeErro, mesclarPagina, type Aba, type ColunaTabela, type LinhaTabela,
} from '../../compartilhado/ui/index.js'
import {
  CARTOES_TIPO, INTERVALO_POLLING_MS, PASSOS, ROTULO_ESTADO, ROTULO_QUALIFICACAO, ROTULO_TIPO, TOM_ESTADO, atualizadoHa, camposDoTipo,
  colunaRepetida, continuaPolling, decodificar, esperadoDoTexto, hashCurto, lerArquivo, mapearCampo, opcoesDeColuna, rotuloMotivo,
  sha256Hex, textoFaltando, type ArquivoLido, type PassoId,
} from './importacao.regras.js'
import {
  ImportacaoServico, type Conferencia, type ImportacaoResumo, type ItemImportacao, type OpcoesImportacao, type ResultadoSimulacao,
} from './importacao.servico.js'

type EstadoHistorico = 'carregando' | 'pronto' | 'erro' | 'sem_permissao'

const ABAS: readonly Aba[] = [{ id: 'nova', rotulo: 'Nova importação' }, { id: 'historico', rotulo: 'Histórico' }]

/**
 * Importar dados (raia H1, #99) — assistente em passos (padrão F) + histórico (padrão L).
 *
 *   1 Tipo → 2 Arquivo (hash no cliente) → 3 Colunas (de-para) → 4 Simulação → 5 Execução → 6 Conferência
 *
 * ⚠️ A SIMULAÇÃO É OBRIGATÓRIA: a execução reenvia o MESMO arquivo e a API só roda se o hash for o simulado. Trocar o
 *    arquivo, o tipo ou o de-para volta para a simulação — o que a pessoa viu é o que acontece.
 * ⚠️ O tenant vem do token. O arquivo é lido no navegador só para mostrar colunas e hash; a API revalida tudo.
 */
@Component({
  selector: 'app-importacao',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AbasComponente, BadgeComponente, CabecalhoTelaComponente, CelulaDiretiva, DatePipe, EstadoComponente, FormPaginaComponente,
    GradeFormComponente, PaginacaoComponente, SecaoFormComponente, SelectComponente, StatCardComponente, TabelaComponente,
  ],
  template: `
    <ui-cabecalho-tela titulo="Importar dados"
      subtitulo="Traga contatos, vendas e tarefas de uma planilha. Você vê o resultado previsto antes de gravar qualquer coisa." />

    <div class="corpo">
      <ui-abas [abas]="abas" [(ativa)]="aba" />

      @if (aba() === 'nova') {
        <ol class="passos" aria-label="Passos da importação">
          @for (p of passos; track p.id) {
            <li class="passo txt-denso" [class.passo--ativo]="passo() === p.id" [class.passo--feito]="p.id < passo()"
                [attr.aria-current]="passo() === p.id ? 'step' : null">
              <span class="passo__n txt-dados">{{ p.id }}</span><span class="passo__rotulo">{{ p.rotulo }}</span>
            </li>
          }
        </ol>

        @switch (passo()) {
          @case (1) {
            <ui-form-pagina titulo="O que você vai importar?" subtitulo="Escolha o tipo e, se quiser, baixe o modelo de planilha.">
              <ui-secao-form titulo="Tipo de dados">
                <div class="cartoes" role="radiogroup" aria-label="Tipo de dados">
                  @for (c of cartoes; track c.tipo) {
                    <button type="button" class="cartao" role="radio" [attr.aria-checked]="tipo() === c.tipo"
                            [class.cartao--ativo]="tipo() === c.tipo" (click)="escolherTipo(c.tipo)">
                      <span class="txt-secao">{{ c.titulo }}</span>
                      <span class="txt-denso cartao__desc">{{ c.descricao }}</span>
                    </button>
                  }
                </div>
              </ui-secao-form>
              <ui-secao-form titulo="Modelo de planilha">
                <p class="txt-corpo suave">O modelo traz o cabeçalho e 2 linhas de exemplo, separado por ponto e vírgula. Abre direto no Excel.</p>
                <div><button type="button" class="btn btn--secundario" [disabled]="!tipo()" (click)="baixarModelo()">Baixar modelo (.csv)</button></div>
              </ui-secao-form>
              <div rodape><button type="button" class="btn btn--primario" [disabled]="!tipo()" (click)="ir(2)">Continuar</button></div>
            </ui-form-pagina>
          }
          @case (2) {
            <ui-form-pagina titulo="Envie o arquivo" subtitulo="CSV com cabeçalho na primeira linha. Aceita ponto e vírgula ou vírgula, até 50 mil linhas e 20 MB.">
              <ui-secao-form titulo="Arquivo CSV">
                <label class="arquivo txt-corpo">
                  <span class="txt-denso">Arquivo (.csv)</span>
                  <input type="file" accept=".csv,text/csv" (change)="escolherArquivo($event)" />
                </label>
                @if (lendo()) { <p class="txt-denso suave">Lendo o arquivo…</p> }
                @if (leitura(); as l) {
                  @if (l.problema) {
                    <p class="aviso aviso--erro txt-denso" role="alert">{{ l.problema }}</p>
                  } @else {
                    <dl class="resumo txt-denso">
                      <div><dt>Arquivo</dt><dd>{{ arquivo()?.name }}</dd></div>
                      <div><dt>Linhas de dados</dt><dd class="txt-dados">{{ l.linhas }}</dd></div>
                      <div><dt>Colunas</dt><dd>{{ l.colunas.join(', ') }}</dd></div>
                      <div><dt>Impressão digital (SHA-256)</dt><dd class="txt-dados hash" [title]="hash()">{{ hashCurto(hash()) }}</dd></div>
                    </dl>
                    <p class="txt-denso suave">A impressão digital identifica este arquivo. A execução só roda se o arquivo enviado for igual ao simulado.</p>
                  }
                }
              </ui-secao-form>
              <div rodape>
                <button type="button" class="btn btn--secundario" (click)="ir(1)">Voltar</button>
                <button type="button" class="btn btn--primario" [disabled]="!podeSeguirDoArquivo()" (click)="ir(3)">Continuar</button>
              </div>
            </ui-form-pagina>
          }
          @case (3) {
            <ui-form-pagina titulo="Associe as colunas" subtitulo="Para cada informação, escolha a coluna do seu arquivo. Já sugerimos o que reconhecemos.">
              <ui-secao-form titulo="Colunas do arquivo">
                <ui-grade-form [colunas]="2">
                  @for (c of campos(); track c.chave) {
                    <ui-select [rotulo]="c.rotulo" [obrigatorio]="c.obrigatorio" [opcoes]="opcoesColuna()"
                      [placeholder]="c.obrigatorio ? 'Selecione a coluna' : 'Não importar'" [valor]="dePara()[c.chave] ?? ''"
                      (valorChange)="mudarCampo(c.chave, $event)"
                      [dica]="repetida(c.chave) ? 'Esta coluna também alimenta outro campo.' : ''" />
                  }
                </ui-grade-form>
                @if (faltando()) { <p class="aviso aviso--atencao txt-denso" role="status">{{ faltando() }}</p> }
              </ui-secao-form>
              @if (tipo() === 'contatos') {
                <ui-secao-form titulo="Opções">
                  <label class="opcao txt-corpo">
                    <input type="checkbox" [checked]="opcoes().criarOrigens" (change)="alternarOpcao('criarOrigens', $event)" />
                    <span>Criar as origens que ainda não existem</span>
                  </label>
                  <label class="opcao txt-corpo">
                    <input type="checkbox" [checked]="opcoes().criarEtiquetas" (change)="alternarOpcao('criarEtiquetas', $event)" />
                    <span>Criar as etiquetas que ainda não existem</span>
                  </label>
                  <p class="txt-denso suave">Sem estas opções, origem ou etiqueta desconhecida não é criada: a linha entra sem ela e fica avisado no relatório.</p>
                </ui-secao-form>
              }
              @if (erroSimulacao()) { <p class="aviso aviso--erro txt-denso" role="alert">{{ erroSimulacao() }}</p> }
              <div rodape>
                <button type="button" class="btn btn--secundario" (click)="ir(2)">Voltar</button>
                <button type="button" class="btn btn--primario" [disabled]="!!faltando() || simulando()" (click)="simular()">
                  {{ simulando() ? 'Simulando…' : 'Simular' }}
                </button>
              </div>
            </ui-form-pagina>
          }
          @case (4) {
            <ui-form-pagina titulo="Resultado da simulação" subtitulo="Nada foi gravado ainda. Confira o que vai acontecer com cada linha.">
              @if (simulacao(); as s) {
                <ui-secao-form titulo="O que vai acontecer">
                  <div class="stats">
                    <ui-stat-card [valor]="s.contagens.linhas" rotulo="Linhas" />
                    <ui-stat-card [valor]="s.contagens.criados" rotulo="Serão criadas" tom="sucesso" />
                    <ui-stat-card [valor]="s.contagens.atualizados" rotulo="Completarão um cadastro" tom="neutro" />
                    <ui-stat-card [valor]="s.contagens.ignorados" rotulo="Ignoradas" />
                    <ui-stat-card [valor]="s.contagens.rejeitados" rotulo="Rejeitadas" [tom]="s.contagens.rejeitados > 0 ? 'erro' : 'neutro'" />
                  </div>
                  <p class="txt-denso suave">Cadastro que já existe é só completado onde estava em branco: nada que já está lá, nem dado vindo do ERP, é sobrescrito.</p>
                </ui-secao-form>
                @if (s.contagens.rejeitados > 0) {
                  <ui-secao-form titulo="Linhas rejeitadas">
                    @if (erroRejeicoes()) { <p class="aviso aviso--erro txt-denso" role="alert">{{ erroRejeicoes() }}</p> }
                    <ui-tabela [colunas]="colunasRejeicao" [linhas]="linhasRejeicao()" [carregando]="carregandoRejeicoes() && rejeicoes().length === 0">
                      <ng-template uiCelula="motivo" let-r>{{ rotuloMotivo(r.motivo) }}</ng-template>
                    </ui-tabela>
                    <ui-paginacao [mostrados]="rejeicoes().length" [total]="s.contagens.rejeitados" [temMais]="cursorRejeicoes() !== null"
                      [carregando]="carregandoRejeicoes()" (mais)="carregarRejeicoes()" />
                  </ui-secao-form>
                }
                @if (erroExecucao()) { <p class="aviso aviso--erro txt-denso" role="alert">{{ erroExecucao() }}</p> }
              }
              @if (simulacao(); as s) {
                <div rodape>
                  <button type="button" class="btn btn--secundario" (click)="ir(3)">Voltar</button>
                  <button type="button" class="btn btn--secundario" (click)="baixarRelatorio(s.importacaoId)">Baixar relatório (CSV)</button>
                  <button type="button" class="btn btn--primario" [disabled]="executando() || (s.contagens.criados + s.contagens.atualizados) === 0"
                          (click)="executar()">{{ executando() ? 'Enviando…' : 'Executar importação' }}</button>
                </div>
              }
            </ui-form-pagina>
          }
          @case (5) {
            <ui-form-pagina titulo="Importação em andamento" subtitulo="Pode sair desta tela: a importação continua no servidor e fica no histórico.">
              @if (detalhe(); as d) {
                <ui-secao-form titulo="Progresso">
                  <div class="situacao">
                    <ui-badge [tom]="tomEstado(d.estado)">{{ rotuloEstado(d.estado) }}</ui-badge>
                    <span class="txt-denso suave">{{ atualizado() }}</span>
                  </div>
                  <progress class="barra" [value]="d.progresso.percentual" max="100"
                            [attr.aria-label]="'Progresso da importação: ' + d.progresso.percentual + '%'"></progress>
                  <p class="txt-denso"><span class="txt-dados">{{ d.progresso.processadas }}</span> de <span class="txt-dados">{{ d.progresso.total }}</span> linhas ({{ d.progresso.percentual }}%)</p>
                  <div class="stats">
                    <ui-stat-card [valor]="d.contagens.criados" rotulo="Criadas" tom="sucesso" />
                    <ui-stat-card [valor]="d.contagens.atualizados" rotulo="Completadas" tom="neutro" />
                    <ui-stat-card [valor]="d.contagens.ignorados" rotulo="Ignoradas" />
                    <ui-stat-card [valor]="d.contagens.rejeitados" rotulo="Rejeitadas" [tom]="d.contagens.rejeitados > 0 ? 'erro' : 'neutro'" />
                  </div>
                  @if (d.estado === 'falhou') {
                    <p class="aviso aviso--erro txt-denso" role="alert">A importação parou por um erro do servidor ({{ d.erro }}). As linhas já gravadas ficam; o relatório mostra até onde foi.</p>
                  }
                </ui-secao-form>
              } @else {
                <ui-estado tipo="erro" titulo="Não foi possível acompanhar a importação" [descricao]="erroProgresso()">
                  <button type="button" class="btn btn--secundario" (click)="atualizarProgresso()">Tentar de novo</button>
                </ui-estado>
              }
              @if (detalhe(); as d) {
                <div rodape>
                  @if (d.estado === 'executando') {
                    <button type="button" class="btn btn--perigo" (click)="cancelar()">Cancelar importação</button>
                  } @else {
                    <button type="button" class="btn btn--secundario" (click)="baixarRelatorio(d.id)">Baixar relatório (CSV)</button>
                    <button type="button" class="btn btn--secundario" (click)="recomecar()">Nova importação</button>
                    @if (d.estado === 'concluida' && d.tipo === 'contatos') {
                      <button type="button" class="btn btn--primario" (click)="abrirConferencia()">Conferir resultado</button>
                    }
                  }
                </div>
              }
            </ui-form-pagina>
          }
          @case (6) {
            <ui-form-pagina titulo="Conferência" subtitulo="O que ficou no banco para os contatos deste arquivo. Digite o esperado do sistema antigo para ver divergências.">
              @switch (estadoConferencia()) {
                @case ('carregando') { <p class="txt-denso suave">Carregando a conferência…</p> }
                @case ('erro') {
                  <ui-estado tipo="erro" titulo="Não foi possível carregar a conferência" [descricao]="erroConferencia()">
                    <button type="button" class="btn btn--secundario" (click)="abrirConferencia()">Tentar de novo</button>
                  </ui-estado>
                }
                @default {
                  <ui-secao-form titulo="Filial, qualificação e origem">
                    <div class="stats">
                      <ui-stat-card [valor]="comparacao().totalReal" rotulo="Contatos no banco" />
                      <ui-stat-card [valor]="comparacao().totalEsperado ?? '—'" rotulo="Esperado (total digitado)" />
                      <ui-stat-card [valor]="comparacao().divergentes" rotulo="Divergências" [tom]="comparacao().divergentes > 0 ? 'atencao' : 'sucesso'" />
                    </div>
                    <ui-tabela [colunas]="colunasConferencia" [linhas]="linhasConferencia()">
                      <ng-template uiCelula="filial" let-l>{{ l.filial ?? 'Sem filial' }}</ng-template>
                      <ng-template uiCelula="qualificacao" let-l>{{ rotuloQualificacao(l.qualificacao) }}</ng-template>
                      <ng-template uiCelula="origem" let-l>{{ l.origem ?? 'Sem origem' }}</ng-template>
                      <ng-template uiCelula="esperado" let-l>
                        <input class="esperado txt-dados" type="text" inputmode="numeric" autocomplete="off"
                               [attr.aria-label]="'Esperado para ' + (l.filial ?? 'sem filial') + ', ' + rotuloQualificacao(l.qualificacao) + ', ' + (l.origem ?? 'sem origem')"
                               [value]="textoEsperado(l.chave)" (input)="definirEsperado(l.chave, $any($event.target).value)" />
                      </ng-template>
                      <ng-template uiCelula="situacao" let-l>
                        @if (l.divergente) {
                          <ui-badge tom="atencao">{{ l.diferenca > 0 ? 'Faltam ' + l.diferenca : 'Sobram ' + -l.diferenca }}</ui-badge>
                        } @else if (l.esperado !== null) {
                          <ui-badge tom="sucesso">Confere</ui-badge>
                        } @else { <span class="suave">—</span> }
                      </ng-template>
                      <div uiVazio><ui-estado titulo="Nenhum contato nesta importação" descricao="Não há contatos criados ou reconhecidos por este arquivo." /></div>
                    </ui-tabela>
                  </ui-secao-form>
                }
              }
              <div rodape>
                <button type="button" class="btn btn--secundario" (click)="recomecar()">Nova importação</button>
                <button type="button" class="btn btn--primario" (click)="aba.set('historico')">Ver histórico</button>
              </div>
            </ui-form-pagina>
          }
        }
      } @else {
        @switch (estadoHistorico()) {
          @case ('sem_permissao') {
            <ui-estado tipo="sem-permissao" titulo="Sem acesso às importações" descricao="Peça acesso a um gestor ou administrador." />
          }
          @case ('erro') {
            <ui-estado tipo="erro" titulo="Não foi possível carregar o histórico" [descricao]="erroHistorico()">
              <button type="button" class="btn btn--secundario" (click)="carregarHistorico()">Tentar de novo</button>
            </ui-estado>
          }
          @default {
            <ui-tabela [colunas]="colunasHistorico" [linhas]="linhasHistorico()" [carregando]="estadoHistorico() === 'carregando'">
              <ng-template uiCelula="arquivo" let-i>
                <span class="arquivo-nome"><span class="nome" [title]="i.arquivoNome">{{ i.arquivoNome }}</span>
                  <span class="txt-denso suave">{{ rotuloTipo(i.tipo) }}</span></span>
              </ng-template>
              <ng-template uiCelula="estado" let-i><ui-badge [tom]="tomEstado(i.estado)">{{ rotuloEstado(i.estado) }}</ui-badge></ng-template>
              <ng-template uiCelula="contagens" let-i>
                <span class="txt-dados">{{ i.contagens.criados }} · {{ i.contagens.atualizados }} · {{ i.contagens.ignorados }} · {{ i.contagens.rejeitados }}</span>
              </ng-template>
              <ng-template uiCelula="criadoEm" let-i>{{ i.criadoEm | date: 'dd/MM/yyyy HH:mm' }}</ng-template>
              <ng-template uiCelula="acoes" let-i>
                <span class="acoes">
                  @if (i.estado === 'executando') {
                    <button type="button" class="btn btn--secundario btn--pequeno" (click)="acompanhar(i)">Acompanhar</button>
                  }
                  @if (i.estado === 'concluida' || i.estado === 'falhou') {
                    <button type="button" class="btn btn--secundario btn--pequeno" (click)="baixarRelatorio(i.id)">Relatório</button>
                  }
                  @if (i.estado === 'concluida' && i.tipo === 'contatos') {
                    <button type="button" class="btn btn--secundario btn--pequeno" (click)="conferirDoHistorico(i)">Conferência</button>
                  }
                </span>
              </ng-template>
              <div uiVazio>
                <ui-estado titulo="Nenhuma importação ainda" descricao="Quando você importar uma planilha, ela aparece aqui com o relatório e a conferência.">
                  <button type="button" class="btn btn--primario" (click)="aba.set('nova')">Importar dados</button>
                </ui-estado>
              </div>
            </ui-tabela>
            @if (estadoHistorico() === 'pronto') {
              <ui-paginacao [mostrados]="historico().length" [temMais]="cursorHistorico() !== null"
                [carregando]="carregandoMais()" (mais)="carregarMaisHistorico()" />
            }
            <p class="txt-denso suave">Colunas de contagem: criadas · completadas · ignoradas · rejeitadas.</p>
          }
        }
      }
    </div>
  `,
  styles: `
    :host { display: block; width: 100%; padding: var(--espacamento-6); }
    .corpo { margin-top: var(--espacamento-4); display: grid; gap: var(--espacamento-4); min-width: 0; }
    .suave { color: var(--texto-secundario); margin: 0; }
    .passos { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: var(--espacamento-2); }
    .passo { display: inline-flex; align-items: center; gap: var(--espacamento-2); padding: var(--espacamento-1) var(--espacamento-3);
      border: 1px solid var(--borda); border-radius: var(--raio-completo); color: var(--texto-secundario); background: var(--superficie); }
    .passo__n { display: inline-grid; place-items: center; min-width: 20px; height: 20px; border-radius: var(--raio-completo);
      background: var(--superficie-hover); color: var(--texto-secundario); }
    .passo--ativo { border-color: var(--acao); color: var(--texto); background: var(--superficie-selecionada); }
    .passo--ativo .passo__n { background: var(--acao); color: var(--acao-texto); }
    .passo--feito .passo__n { background: var(--sucesso-suave); color: var(--sucesso); }
    .cartoes { display: grid; gap: var(--espacamento-3); grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .cartao { display: grid; gap: var(--espacamento-2); text-align: left; padding: var(--espacamento-4); font: inherit; cursor: pointer;
      color: var(--texto); background: var(--superficie); border: 1px solid var(--borda-controle); border-radius: var(--raio-painel); }
    .cartao:hover { background: var(--superficie-hover); }
    .cartao:focus-visible { outline: none; border-color: var(--borda-foco); box-shadow: 0 0 0 2px var(--borda-foco); }
    .cartao--ativo { border-color: var(--acao); background: var(--superficie-selecionada); }
    .cartao__desc { color: var(--texto-secundario); }
    .arquivo { display: grid; gap: var(--espacamento-1); }
    .resumo { display: grid; gap: var(--espacamento-2); margin: 0; }
    .resumo > div { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: var(--espacamento-3); }
    .resumo dt { color: var(--texto-secundario); }
    .resumo dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
    .hash { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .aviso { margin: 0; padding: var(--espacamento-2) var(--espacamento-3); border-radius: var(--raio-controle); }
    .aviso--erro { background: var(--erro-suave); color: var(--texto); border: 1px solid var(--erro); }
    .aviso--atencao { background: var(--atencao-suave); color: var(--texto); border: 1px solid var(--atencao); }
    .opcao { display: flex; align-items: center; gap: var(--espacamento-2); }
    .stats { display: grid; gap: var(--espacamento-3); grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
    .situacao { display: flex; align-items: center; gap: var(--espacamento-3); }
    .barra { width: 100%; height: 12px; accent-color: var(--acao); }
    .esperado { width: 96px; max-width: 100%; padding: var(--espacamento-1) var(--espacamento-2); text-align: right; font: inherit;
      color: var(--texto); background: var(--superficie); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); }
    .esperado:focus-visible { outline: none; border-color: var(--borda-foco); box-shadow: 0 0 0 2px var(--borda-foco); }
    ui-tabela { display: block; }
    .arquivo-nome { display: grid; min-width: 0; }
    .nome { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
    .acoes { display: inline-flex; flex-wrap: wrap; gap: var(--espacamento-2); justify-content: flex-end; }
    @media (max-width: 720px) {
      :host { padding: var(--espacamento-4); }
      .cartoes { grid-template-columns: 1fr; }
      .resumo > div { grid-template-columns: 1fr; gap: 0; }
    }
  `,
})
export class ImportacaoPagina implements OnInit {
  private readonly api = inject(ImportacaoServico)
  private readonly toast = inject(ToastServico)
  private readonly confirmacao = inject(ConfirmacaoServico)

  protected readonly abas = ABAS
  protected readonly passos = PASSOS
  protected readonly cartoes = CARTOES_TIPO
  protected readonly aba = signal('nova')
  protected readonly passo = signal<PassoId>(1)

  // 1–3 · tipo, arquivo, de-para
  protected readonly tipo = signal<TipoImportacao | null>(null)
  protected readonly arquivo = signal<File | null>(null)
  protected readonly hash = signal('')
  protected readonly lendo = signal(false)
  protected readonly leitura = signal<ArquivoLido | null>(null)
  protected readonly dePara = signal<DePara>({})
  protected readonly opcoes = signal<OpcoesImportacao>({ criarOrigens: false, criarEtiquetas: false })
  protected readonly campos = computed(() => { const t = this.tipo(); return t ? camposDoTipo(t) : [] })
  protected readonly opcoesColuna = computed(() => opcoesDeColuna(this.leitura()?.colunas ?? []))
  protected readonly faltando = computed(() => {
    const t = this.tipo()
    return t ? textoFaltando(t, this.dePara(), this.leitura()?.colunas ?? []) : ''
  })
  protected readonly podeSeguirDoArquivo = computed(() => !!this.arquivo() && !this.lendo() && !!this.leitura() && this.leitura()!.problema === null)

  // 4 · simulação
  protected readonly simulando = signal(false)
  protected readonly erroSimulacao = signal('')
  protected readonly simulacao = signal<ResultadoSimulacao | null>(null)
  protected readonly rejeicoes = signal<readonly ItemImportacao[]>([])
  protected readonly cursorRejeicoes = signal<string | null>(null)
  protected readonly carregandoRejeicoes = signal(false)
  protected readonly erroRejeicoes = signal('')
  protected readonly linhasRejeicao = computed<readonly LinhaTabela[]>(() =>
    this.rejeicoes().map((r) => ({ id: String(r.linha), linha: r.linha, motivo: r.motivo })))
  protected readonly colunasRejeicao: ColunaTabela[] = [
    { chave: 'linha', rotulo: 'Linha do arquivo', mono: true, largura: '160px' },
    { chave: 'motivo', rotulo: 'Motivo' },
  ]
  protected readonly executando = signal(false)
  protected readonly erroExecucao = signal('')

  // 5 · progresso
  protected readonly detalhe = signal<ImportacaoResumo | null>(null)
  protected readonly erroProgresso = signal('')
  private readonly agora = signal(Date.now())
  protected readonly atualizado = computed(() => { const d = this.detalhe(); return d ? atualizadoHa(d.atualizadoEm, this.agora()) : '' })
  private importacaoId: string | null = null
  private polling: ReturnType<typeof setInterval> | null = null

  // 6 · conferência
  protected readonly estadoConferencia = signal<'carregando' | 'pronto' | 'erro'>('carregando')
  protected readonly erroConferencia = signal('')
  private readonly conferencia = signal<Conferencia | null>(null)
  protected readonly esperado = signal<Record<string, number | null>>({})
  private readonly digitado = signal<Record<string, string>>({})
  protected readonly comparacao = computed(() => compararConferencia(this.conferencia()?.linhas ?? [], this.esperado()))
  protected readonly linhasConferencia = computed<readonly LinhaTabela[]>(() =>
    this.comparacao().linhas.map((l) => ({ ...l, id: l.chave }) as unknown as LinhaTabela))
  protected readonly colunasConferencia: ColunaTabela[] = [
    { chave: 'filial', rotulo: 'Filial' },
    { chave: 'qualificacao', rotulo: 'Qualificação', largura: '140px' },
    { chave: 'origem', rotulo: 'Origem' },
    { chave: 'total', rotulo: 'No banco', mono: true, alinhamento: 'dir', largura: '100px' },
    { chave: 'esperado', rotulo: 'Esperado', alinhamento: 'dir', largura: '130px' },
    { chave: 'situacao', rotulo: 'Situação', largura: '130px' },
  ]

  // Histórico
  protected readonly estadoHistorico = signal<EstadoHistorico>('carregando')
  protected readonly erroHistorico = signal('')
  protected readonly historico = signal<readonly ImportacaoResumo[]>([])
  protected readonly linhasHistorico = computed(() => this.historico() as unknown as readonly LinhaTabela[])
  protected readonly cursorHistorico = signal<string | null>(null)
  protected readonly carregandoMais = signal(false)
  protected readonly colunasHistorico: ColunaTabela[] = [
    { chave: 'arquivo', rotulo: 'Arquivo' },
    { chave: 'estado', rotulo: 'Situação', largura: '130px' },
    { chave: 'contagens', rotulo: 'Resultado', alinhamento: 'dir', largura: '170px' },
    { chave: 'criadoEm', rotulo: 'Criada em', largura: '150px' },
    { chave: 'acoes', rotulo: 'Ações', alinhamento: 'dir', largura: '240px' },
  ]

  protected readonly hashCurto = hashCurto
  protected readonly rotuloMotivo = rotuloMotivo
  protected readonly rotuloEstado = (e: keyof typeof ROTULO_ESTADO) => ROTULO_ESTADO[e]
  protected readonly tomEstado = (e: keyof typeof TOM_ESTADO) => TOM_ESTADO[e]
  protected readonly rotuloTipo = (t: TipoImportacao) => ROTULO_TIPO[t]
  protected readonly rotuloQualificacao = (q: string) => ROTULO_QUALIFICACAO[q] ?? q

  constructor() {
    const destroy = inject(DestroyRef)
    const relogio = setInterval(() => this.agora.set(Date.now()), 1000)
    destroy.onDestroy(() => { clearInterval(relogio); this.pararPolling() })
  }

  ngOnInit(): void { void this.carregarHistorico() }

  protected ir(p: PassoId): void { this.passo.set(p) }

  // ── 1 · tipo ──
  protected escolherTipo(t: TipoImportacao): void {
    if (this.tipo() === t) return
    this.tipo.set(t)
    this.reiniciarArquivo()
  }

  protected async baixarModelo(): Promise<void> {
    const t = this.tipo()
    if (!t) return
    try { await this.api.baixarModelo(t) } catch (e) { this.toast.erro(mensagemDeErro(e, 'Não foi possível baixar o modelo.')) }
  }

  // ── 2 · arquivo ──
  private reiniciarArquivo(): void {
    this.arquivo.set(null); this.hash.set(''); this.leitura.set(null); this.dePara.set({}); this.simulacao.set(null)
    this.erroSimulacao.set(''); this.erroExecucao.set('')
  }

  protected async escolherArquivo(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement
    const f = input.files?.[0] ?? null
    const t = this.tipo()
    this.reiniciarArquivo()
    if (!f || !t) return
    this.arquivo.set(f)
    this.lendo.set(true)
    try {
      const bytes = await f.arrayBuffer()
      const leitura = lerArquivo(decodificar(bytes), t, f.size)
      this.hash.set(await sha256Hex(bytes))
      this.leitura.set(leitura)
      this.dePara.set(leitura.deParaSugerido)
    } catch {
      this.leitura.set({ colunas: [], linhas: 0, deParaSugerido: {}, problema: 'Não foi possível ler o arquivo. Tente salvá-lo de novo como CSV.' })
    } finally { this.lendo.set(false) }
  }

  // ── 3 · de-para ──
  protected mudarCampo(campo: string, coluna: string): void {
    this.dePara.update((d) => mapearCampo(d, campo, coluna))
    this.simulacao.set(null) // mudou o mapeamento: a simulação anterior já não vale
  }
  protected repetida(campo: string): boolean { return colunaRepetida(this.dePara(), campo) }
  protected alternarOpcao(chave: keyof OpcoesImportacao, ev: Event): void {
    this.opcoes.update((o) => ({ ...o, [chave]: (ev.target as HTMLInputElement).checked }))
    this.simulacao.set(null)
  }

  // ── 4 · simulação ──
  protected async simular(): Promise<void> {
    const t = this.tipo(), f = this.arquivo()
    if (!t || !f || this.simulando()) return
    this.simulando.set(true); this.erroSimulacao.set(''); this.erroExecucao.set('')
    try {
      const r = await this.api.simular(t, f, this.dePara(), this.opcoes())
      this.simulacao.set(r)
      this.rejeicoes.set([]); this.cursorRejeicoes.set(null)
      this.passo.set(4)
      if (r.contagens.rejeitados > 0) void this.carregarRejeicoes()
    } catch (e) {
      if (codigoDoErro(e) === 'importacao.colunas_obrigatorias') {
        const c = corpoDoErro(e) as { deParaSugerido?: DePara } | null
        if (c?.deParaSugerido) this.dePara.set(c.deParaSugerido)
      }
      this.erroSimulacao.set(mensagemDeErro(e, 'Não foi possível simular. Verifique o arquivo e tente de novo.'))
    } finally { this.simulando.set(false) }
  }

  /** Rejeições da simulação, por cursor ("carregar mais"): todas as linhas, não só uma amostra. */
  protected async carregarRejeicoes(): Promise<void> {
    const s = this.simulacao()
    if (!s || this.carregandoRejeicoes()) return
    const cursor = this.cursorRejeicoes()
    if (this.rejeicoes().length > 0 && cursor === null) return
    this.carregandoRejeicoes.set(true); this.erroRejeicoes.set('')
    try {
      const r = await this.api.itens(s.importacaoId, 'rejeitado', cursor)
      this.rejeicoes.update((a) => [...a, ...r.itens])
      this.cursorRejeicoes.set(r.proximoCursor)
    } catch (e) { this.erroRejeicoes.set(mensagemDeErro(e, 'Não foi possível carregar as linhas rejeitadas.')) }
    finally { this.carregandoRejeicoes.set(false) }
  }

  protected async baixarRelatorio(id: string): Promise<void> {
    try { await this.api.baixarRelatorio(id) } catch (e) { this.toast.erro(mensagemDeErro(e, 'Não foi possível baixar o relatório.')) }
  }

  // ── 5 · execução ──
  protected async executar(): Promise<void> {
    const t = this.tipo(), f = this.arquivo(), s = this.simulacao()
    if (!t || !f || !s || this.executando()) return
    const gravam = s.contagens.criados + s.contagens.atualizados
    const ok = await this.confirmacao.confirmar({
      titulo: 'Executar a importação?',
      mensagem: `${gravam} linha(s) vão gravar na sua base (${s.contagens.criados} novas, ${s.contagens.atualizados} completando cadastros) e `
        + `${s.contagens.rejeitados} serão rejeitadas. Não há desfazer automático.`,
      acao: 'Executar',
    })
    if (!ok) return
    this.executando.set(true); this.erroExecucao.set('')
    try {
      await this.api.executar(s.importacaoId, f, this.dePara(), this.opcoes())
      this.importacaoId = s.importacaoId
      this.detalhe.set(null)
      this.passo.set(5)
      await this.atualizarProgresso()
      this.iniciarPolling()
    } catch (e) {
      const codigo = codigoDoErro(e)
      this.erroExecucao.set(codigo === 'importacao.nao_simulada' || codigo === 'importacao.de_para_mudou'
        ? 'O arquivo ou as colunas mudaram depois da simulação. Volte e simule de novo.'
        : mensagemDeErro(e, 'Não foi possível iniciar a importação.'))
    } finally { this.executando.set(false) }
  }

  protected async atualizarProgresso(): Promise<void> {
    const id = this.importacaoId
    if (!id) return
    try {
      const d = await this.api.obter(id)
      this.detalhe.set(d); this.erroProgresso.set('')
      this.agora.set(Date.now())
      if (!continuaPolling(d.estado)) this.pararPolling()
    } catch (e) {
      this.erroProgresso.set(mensagemDeErro(e, 'Verifique a conexão e tente de novo.'))
      if (this.detalhe() === null) this.pararPolling()
    }
  }

  private iniciarPolling(): void {
    this.pararPolling()
    this.polling = setInterval(() => { void this.atualizarProgresso() }, INTERVALO_POLLING_MS)
  }
  private pararPolling(): void { if (this.polling) { clearInterval(this.polling); this.polling = null } }

  protected async cancelar(): Promise<void> {
    const id = this.importacaoId
    if (!id) return
    const ok = await this.confirmacao.confirmar({
      titulo: 'Cancelar a importação?', mensagem: 'As linhas já gravadas ficam na base. O restante não será importado.', acao: 'Cancelar importação', perigo: true,
    })
    if (!ok) return
    try { await this.api.cancelar(id); await this.atualizarProgresso(); void this.carregarHistorico() }
    catch (e) { this.toast.erro(mensagemDeErro(e, 'Não foi possível cancelar.')) }
  }

  protected recomecar(): void {
    this.pararPolling()
    this.importacaoId = null
    this.tipo.set(null); this.reiniciarArquivo()
    this.detalhe.set(null); this.conferencia.set(null); this.esperado.set({}); this.digitado.set({})
    this.passo.set(1); this.aba.set('nova')
    void this.carregarHistorico()
  }

  // ── 6 · conferência ──
  protected async abrirConferencia(): Promise<void> {
    const id = this.importacaoId
    if (!id) return
    this.passo.set(6)
    this.estadoConferencia.set('carregando')
    try {
      this.conferencia.set(await this.api.conferencia(id))
      this.estadoConferencia.set('pronto')
    } catch (e) {
      this.erroConferencia.set(mensagemDeErro(e, 'Verifique a conexão e tente de novo.'))
      this.estadoConferencia.set('erro')
    }
  }
  protected textoEsperado(chave: string): string { return this.digitado()[chave] ?? '' }
  protected definirEsperado(chave: string, texto: string): void {
    this.digitado.update((d) => ({ ...d, [chave]: texto }))
    this.esperado.update((e) => ({ ...e, [chave]: esperadoDoTexto(texto) }))
  }

  // ── histórico ──
  protected async carregarHistorico(): Promise<void> {
    this.estadoHistorico.set('carregando')
    try {
      const r = await this.api.listar(null)
      this.historico.set(r.itens); this.cursorHistorico.set(r.proximoCursor)
      this.estadoHistorico.set('pronto')
    } catch (e) {
      if (ehStatus(e, 403)) this.estadoHistorico.set('sem_permissao')
      else { this.erroHistorico.set(mensagemDeErro(e, 'Verifique a conexão e tente de novo.')); this.estadoHistorico.set('erro') }
    }
  }

  protected async carregarMaisHistorico(): Promise<void> {
    const c = this.cursorHistorico()
    if (!c || this.carregandoMais()) return
    this.carregandoMais.set(true)
    try {
      const r = await this.api.listar(c)
      this.historico.update((a) => mesclarPagina(a, r.itens, (i) => i.id))
      this.cursorHistorico.set(r.proximoCursor)
    } catch (e) { this.toast.erro(mensagemDeErro(e, 'Não foi possível carregar mais importações.')) }
    finally { this.carregandoMais.set(false) }
  }

  protected acompanhar(i: ImportacaoResumo): void {
    this.importacaoId = i.id
    this.tipo.set(i.tipo)
    this.detalhe.set(i)
    this.aba.set('nova'); this.passo.set(5)
    void this.atualizarProgresso()
    this.iniciarPolling()
  }

  protected conferirDoHistorico(i: ImportacaoResumo): void {
    this.importacaoId = i.id
    this.tipo.set(i.tipo)
    this.detalhe.set(i)
    this.esperado.set({}); this.digitado.set({})
    this.aba.set('nova')
    void this.abrirConferencia()
  }
}
