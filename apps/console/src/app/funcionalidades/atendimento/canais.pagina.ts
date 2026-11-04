import { Component, ChangeDetectionStrategy, inject, signal, computed, OnInit, OnDestroy } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import { RouterLink } from '@angular/router'
import { CanaisServico, type Canal } from './canais.servico.js'
import { rotuloSuspensao } from './agente/ativas.regras.js'
import { FormularioCredencialComponente } from '../integracao/formulario-credencial.componente.js'
import {
  BadgeComponente, CabecalhoTelaComponente, CampoComponente, CelulaDiretiva, EstadoComponente, EsqueletoComponente,
  IconeComponente, ModalComponente, SelectComponente, StatCardComponente, TabelaComponente,
  type ColunaTabela, type LinhaTabela, type OpcaoSelect, type TomStat,
} from '../../compartilhado/ui/index.js'
import {
  abrirAvancado, avisoDeRemocao, corpoDaApi, idadeVerificacao, intervaloDePolling, mensagemFalhaQr, mudancasDaEdicao,
  POLL_RAPIDO_MS, rotuloModoAgente, seloRestricaoModo, verificacaoAtrasada,
} from './canais.regras.js'

/** ⚠️ O QR do fornecedor expira em segundos; 20s renova ANTES de morrer. */
const SEGUNDOS_QR = 20
/** Teto (~3 min). Aba esquecida não bate no fornecedor a noite toda. */
const MAX_RENOVACOES = 9

/**
 * Cadastro de celular / canal — Meta (oficial) e não-oficiais (PlugZapi + futuros).
 *
 * Padrão Lista (L) com cadastro em modal (M): a frota é uma tabela; o QR de
 * reconexão e o cadastro abrem em `ui-modal`; a confirmação de remoção também.
 *
 * ⚠️ O formulário é DESENHADO do catálogo de provedores (`/v1/canais/provedores`),
 * como a tela de ERP. Provedor novo entra no catálogo e aparece aqui sem tocar
 * neste componente. O aviso de RISCO do não-oficial aparece em destaque (ADR-021).
 */
@Component({
  selector: 'app-canais',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    BadgeComponente, CabecalhoTelaComponente, CampoComponente, CelulaDiretiva, EstadoComponente, EsqueletoComponente,
    FormularioCredencialComponente, IconeComponente, ModalComponente, RouterLink, SelectComponente, StatCardComponente,
    TabelaComponente,
  ],
  template: `
    <ui-cabecalho-tela titulo="Números de WhatsApp"
      subtitulo="Conecte números oficiais (Meta) e não-oficiais. O cliente escolhe por qual caminho falar.">
      @if (servico.estado() === 'pronto' && !servico.vazio()) {
        <button type="button" class="btn btn--primario" (click)="abrir()"><ui-icone nome="plus" />Conectar número</button>
      }
    </ui-cabecalho-tela>

    <div class="corpo">
      @switch (servico.estado()) {
        @case ('carregando') {
          <ui-tabela [colunas]="colunas" [linhas]="[]" [carregando]="true" />
        }
        @case ('sem_permissao') {
          <ui-estado tipo="sem-permissao" titulo="Você não tem acesso aos números"
            descricao="Peça a um administrador da sua empresa para liberar este acesso." />
        }
        <!-- ⚠️ Estado PRÓPRIO: quem caiu foi o servidor do GeraCRM, não o número.
             "Erro ao carregar" faria a pessoa ir mexer no celular. -->
        @case ('servidor_indisponivel') {
          <ui-estado tipo="erro" titulo="Servidor do GeraCRM indisponível"
            descricao="Não conseguimos falar com o servidor agora. Isso não quer dizer que seus números caíram: o estado deles aparece assim que o servidor voltar. A tela tenta de novo sozinha.">
            <button type="button" class="btn btn--secundario" (click)="servico.carregar()">Tentar agora</button>
          </ui-estado>
        }
        @case ('erro') {
          <ui-estado tipo="erro" titulo="Não foi possível carregar os números" [descricao]="servico.erro() ?? ''">
            <button type="button" class="btn btn--secundario" (click)="servico.carregar()">Tentar de novo</button>
          </ui-estado>
        }
        @case ('pronto') {
          <!-- O desfecho da remoção é DIFERENTE por número (apagado × arquivado),
               e quem clicou precisa saber qual dos dois aconteceu. -->
          @if (avisoRemocao(); as m) {
            <p class="aviso-faixa aviso-faixa--ok" role="status"><ui-icone nome="check" />{{ m }}</p>
          }
          <!-- ⚠️ Servidor fora DURANTE o polling: a lista abaixo é a última
               leitura. Dizer desde quando evita que o estado velho passe por atual. -->
          @if (servico.indisponivelDesde(); as desde) {
            <p class="aviso-faixa" role="status">
              <ui-icone nome="alert-triangle" /><strong>Servidor indisponível desde {{ hora(desde) }}.</strong>
              Os estados abaixo são da última leitura; a tela tenta de novo sozinha.
            </p>
          } @else if (servico.erroAtualizacao(); as m) {
            <p class="aviso-faixa" role="status"><ui-icone nome="alert-triangle" />{{ m }} A tela tenta de novo sozinha.</p>
          }
          @if (servico.vazio()) {
            <ui-estado titulo="Nenhum número conectado"
              descricao="Conecte um número oficial (Meta) ou não-oficial (PlugZapi) para começar a conversar.">
              <button type="button" class="btn btn--primario" (click)="abrir()">Conectar meu primeiro número</button>
            </ui-estado>
          } @else {
            <!-- Saúde da frota (EP-03): o que exige olho agora. -->
            @if (servico.saude(); as s) {
              <div class="saude">
                <ui-stat-card [valor]="valorEntrega(s.entrega)" [rotulo]="rotuloEntrega(s.entrega)"
                  [tom]="tomEntrega(s.entrega)" />
                <ui-stat-card [valor]="s.alertasAbertos" rotulo="Alertas abertos"
                  [tom]="s.alertasAbertos > 0 ? 'erro' : 'neutro'" />
              </div>
            }
            <ui-tabela [colunas]="colunas" [linhas]="linhas()">
              <ng-template uiCelula="numero" let-c>
                <span class="pessoa">
                  <strong class="nome">{{ c.nomeAmigavel }}</strong>
                  <!-- ⚠️ Número e id chegam MASCARADOS da API (LGPD): dá para
                       distinguir os números da frota, não para discá-los. -->
                  @if (c.telefoneMascarado || c.identificadorMascarado) {
                    <span class="txt-dados suave">
                      @if (c.telefoneMascarado; as t) { <span>{{ t }}</span> }
                      @if (c.identificadorMascarado; as i) { <span>ID {{ i }}</span> }
                    </span>
                  }
                </span>
              </ng-template>
              <ng-template uiCelula="tipo" let-c>
                <span class="tags">
                  <ui-badge [tom]="ehOficial(c) ? 'sucesso' : 'neutro'">{{ ehOficial(c) ? 'Oficial (Meta)' : 'Não-oficial' }}</ui-badge>
                  <ui-badge>{{ nomeProvedor(c.provedor) }}</ui-badge>
                  @if (!ehOficial(c)) {
                    <ui-badge tom="erro"><ui-icone nome="alert-triangle" [tamanho]="14" />risco de banimento</ui-badge>
                  }
                </span>
              </ng-template>
              <ng-template uiCelula="agente" let-c>
                <span class="tags">
                  <ui-badge [tom]="c.modoAgente && c.modoAgente !== 'desligado' ? 'info' : 'neutro'">{{ rotuloModo(c.modoAgente) }}</ui-badge>
                  @if (seloModo(c); as selo) {
                    <ui-badge tom="atencao" [title]="selo.dica">{{ selo.rotulo }}</ui-badge>
                  }
                </span>
              </ng-template>
              <!-- ⚠️ O estado NUNCA aparece sozinho: vem com quando foi
                   observado. "Conectado" sem prazo de validade foi o que
                   deixou um número morto passar por saudável em 24/ago. -->
              <ng-template uiCelula="estado" let-c>
                <ui-badge [tom]="c.estado === 'conectado' ? 'sucesso' : c.estado === 'desconectado' ? 'erro' : 'neutro'">
                  {{ rotuloEstado(c.estado) }}
                </ui-badge>
                <span class="carimbo" [class.suspeito]="carimboSuspeito(c)">{{ carimbo(c) }}</span>
              </ng-template>
              <ng-template uiCelula="situacao" let-c>
                <div class="situacao">
                  @if (c.estado === 'desconectado' && c.ultimoErro) {
                    <p class="err">{{ c.ultimoErro }}</p>
                  }
                  <!-- ⚠️ Pausa VISÍVEL na tela da frota. E o texto diz o que
                       CONTINUA funcionando — senão lê-se "o número parou". -->
                  @if (c.disparoPausado) {
                    <p class="pausado">
                      <ui-icone nome="alert-triangle" [tamanho]="14" /><strong>Disparo pausado</strong>{{ c.pausadoMotivo ? ' — ' + c.pausadoMotivo : '' }}
                      <span class="pausado-ok">Respostas em conversas abertas continuam saindo normalmente.</span>
                      <a routerLink="/canal-config">Retomar em Configuração do canal</a>
                    </p>
                  }
                  <!-- Ativas suspensas (qualidade do número caiu, P11): o que para é
                       o contato ATIVO; responder quem escreveu continua. -->
                  @if (c.ativasSuspensas; as s) {
                    <p class="pausado">
                      <ui-icone nome="alert-triangle" [tamanho]="14" /><strong>Mensagens ativas suspensas</strong> desde {{ dataHora(s.desde) }}.{{ s.motivo ? ' ' + rotuloSuspensao(s.motivo) : '' }}
                      <span class="pausado-ok">Respostas a quem escreveu continuam saindo normalmente.</span>
                    </p>
                  }
                  @if (!ehOficial(c) && servico.aquecimento()[c.id]?.emAquecimento) {
                    <span class="aquec">Aquecimento dia {{ servico.aquecimento()[c.id]!.dia }} · hoje {{ servico.aquecimento()[c.id]!.usadoHoje }}/{{ servico.aquecimento()[c.id]!.limiteHoje }}</span>
                  }
                  @if (servico.erroAquecimento()[c.id]; as e) {
                    <span class="aquec-erro" role="alert">{{ e }}</span>
                  }
                  @if (resultado()[c.id]; as r) {
                    <p class="resultado" [class.ok]="r.conectado" role="status">
                      <ui-icone [nome]="r.conectado ? 'check' : 'alert-triangle'" [tamanho]="14" />
                      {{ r.conectado ? 'Conectado' : (r.detalhe || 'Desconectado') }}
                      <!-- ⚠️ "Conectado" sem carimbo de hora é afirmação sem prazo
                           de validade. -->
                      <span class="quando">· verificado {{ verificadoEm()[c.id] }}</span>
                    </p>
                  }
                  <!-- ⚠️ SÓ ADMIN (P10): o QR pareia QUALQUER aparelho ao número. -->
                  @if (!ehOficial(c) && !c.podeParear) {
                    <p class="so-admin">Parear um aparelho (QR) é com o administrador da conta. Você acompanha o estado por aqui.</p>
                  }
                </div>
              </ng-template>
              <ng-template uiCelula="acoes" let-c>
                <span class="acoes">
                  <button type="button" class="btn btn--secundario btn--pequeno" (click)="testar(c)" [disabled]="servico.testando().has(c.id)">
                    {{ servico.testando().has(c.id) ? 'Testando…' : 'Testar conexão' }}
                  </button>
                  @if (!ehOficial(c) && !servico.aquecimento()[c.id]?.emAquecimento) {
                    <button type="button" class="btn btn--secundario btn--pequeno" (click)="servico.iniciarAquecimento(c.id)">Iniciar aquecimento</button>
                  }
                  <!-- Reconexão por QR: só no não-oficial, e SEMPRE disponível, não só
                       quando o sistema já sabe que caiu (ação de recuperação não depende
                       do diagnóstico). -->
                  @if (!ehOficial(c) && c.podeParear) {
                    <button type="button" class="btn btn--secundario btn--pequeno" (click)="abrirQr(c.id)" [disabled]="buscandoQr() === c.id">
                      <ui-icone nome="smartphone" [tamanho]="14" />{{ c.estado === 'desconectado' ? 'Reconectar por QR' : 'Conectar outro aparelho' }}
                    </button>
                  }
                  <!-- ⚠️ Editar e Remover existem porque cadastro errado era
                       PERMANENTE: detectar sem oferecer o conserto é meio caminho. -->
                  <button type="button" class="btn btn--secundario btn--pequeno" (click)="abrirEdicao(c)">Editar</button>
                  <button type="button" class="btn btn--perigo btn--pequeno" (click)="pedirRemocao(c)">Remover</button>
                </span>
              </ng-template>
              <div uiVazio>
                <ui-estado titulo="Nenhum número conectado" descricao="Conecte um número para começar a conversar.">
                  <button type="button" class="btn btn--primario" (click)="abrir()">Conectar número</button>
                </ui-estado>
              </div>
            </ui-tabela>
          }
        }
      }
    </div>

    <!-- QR de reconexão: modal próprio. Fechar encerra a sessão de pareamento. -->
    <ui-modal [aberto]="qrCanalId() !== null" titulo="Reconectar por QR" largura="p" (fechar)="fecharQr()">
      @if (qrCanalId(); as id) {
        @if (qr()[id]?.imagem; as imagem) {
          <div class="qr">
            <img [src]="imagem" alt="QR code para parear o WhatsApp" width="240" height="240" />
            <p class="passos">
              No celular deste número: <strong>WhatsApp → Aparelhos conectados → Conectar aparelho</strong>, e aponte para o código.
            </p>
            <!-- ⚠️ O QR expira em segundos e muda a cada leitura; por isso o botão
                 de gerar outro fica no rodapé. -->
            <p class="expira">
              @if (restante()[id]; as seg) {
                <span class="relogio" [class.urgente]="seg <= 5">{{ seg }}s</span>
                <span> — o código se renova sozinho</span>
              } @else {
                <span>Aponte a câmera do celular para o código</span>
              }
            </p>
          </div>
        } @else if (qr()[id]?.erro; as erro) {
          <p class="erro-geral" role="alert"><ui-icone nome="alert-triangle" />{{ erro }}</p>
        } @else {
          <ui-esqueleto altura="240px" />
        }
      }
      <div rodape>
        <button type="button" class="btn btn--secundario" (click)="fecharQr()">Fechar</button>
        <button type="button" class="btn btn--primario" (click)="gerarOutroQr()" [disabled]="buscandoQr() !== null">
          {{ buscandoQr() !== null ? 'Gerando…' : 'Gerar outro QR' }}
        </button>
      </div>
    </ui-modal>

    <!-- Cadastro e edição: modal. ⚠️ O tipo NÃO muda na edição (campos e webhook são outros). -->
    <ui-modal [aberto]="editando() !== null" [titulo]="tituloEdicao()" largura="m" (fechar)="fechar()">
      @if (editando(); as ed) {
        @if (ed.id) {
          <p class="tipo-fixo">{{ provedorAtual()?.nome }} · o tipo do número não muda na edição.</p>
        } @else {
          <ui-select rotulo="Tipo de número" [opcoes]="opcoesProvedores()" [valor]="ed.provedor"
            (valorChange)="trocarProvedor($event)" [dica]="provedorAtual()?.descricao ?? ''" />
        }

        <!-- ⚠️ Aviso de risco do não-oficial em DESTAQUE (ADR-021). -->
        @if (provedorAtual()?.aviso; as aviso) {
          <p class="aviso-risco" role="note"><ui-icone nome="alert-triangle" />{{ aviso }}</p>
        }

        <ui-campo rotulo="Como chamar este número" placeholder="Ex.: WhatsApp da loja"
          dica="Aparece nas telas e mensagens do sistema." [valor]="ed.nome" (valorChange)="nomeMudou($event)"
          [erro]="erros()['nomeAmigavel'] ?? null" />

        <!-- ⚠️ Em branco NÃO apaga: o servidor mescla com o que já está guardado. -->
        @if (ed.id) {
          <p class="nota-credencial">
            @if (camposConfigurados().length) {
              Credencial configurada: {{ camposConfigurados().join(', ') }}.
            }
            Preencha só o que vai mudar — campo em branco mantém o valor atual.
          </p>
        }

        @if (provedorAtual(); as p) {
          @if (p.oficial) {
            <!-- ⚠️ No OFICIAL a credencial é MESMO do cliente: o App e a WABA são dele. -->
            <app-formulario-credencial [esquema]="p.esquemaCredencial" [erros]="erros()"
                                       (mudou)="credencialMudou($event)" />
          } @else {
            <!-- ⚠️ No NÃO-OFICIAL a instância pertence ao contrato da DREZZ com o
                 fornecedor. O cliente não tem instância nem token: o caminho dele é
                 dar um nome e escanear o QR. Os campos viram ÁREA DA EQUIPE. -->
            <p class="nota-equipe">
              Quem conecta este número é a equipe Drezz: a instância é criada por nós e
              você só escaneia o QR no celular. Se ninguém da equipe estiver com você
              agora, peça a ativação pelo suporte — o número aparece aqui em seguida.
            </p>
            <details class="avancado" [open]="avancadoAberto()">
              <summary (click)="alternarAvancado($event)">Opções avançadas — equipe Drezz</summary>
              <p class="aviso-credencial">
                Estes dados são da conta da Drezz com o fornecedor, não do cliente.
                Não peça por WhatsApp, não mande por e-mail e não deixe em print.
              </p>
              <app-formulario-credencial [esquema]="p.esquemaCredencial" [erros]="erros()"
                                         (mudou)="credencialMudou($event)" />
            </details>
          }
        }

        @if (erroGeral(); as m) { <p class="erro-geral" role="alert">{{ m }}</p> }
      }
      <div rodape>
        <button type="button" class="btn btn--secundario" (click)="fechar()">Cancelar</button>
        <button type="button" class="btn btn--primario" (click)="salvar()" [disabled]="salvando()">
          {{ salvando() ? 'Salvando…' : editando()?.id ? 'Salvar alterações' : 'Salvar e testar' }}
        </button>
      </div>
    </ui-modal>

    <!-- Confirmação em modal PRÓPRIO, nunca o confirm() do navegador: é aqui
         que cabe explicar o desfecho — apagar de vez × arquivar com o histórico de pé. -->
    <ui-modal [aberto]="confirmandoRemocao() !== null" [titulo]="tituloRemocao()" largura="p" (fechar)="cancelarRemocao()">
      <p class="explica">
        O número sai da frota: some desta tela, para de ser verificado e não envia mais
        por nenhum caminho — nem campanha, nem resposta em conversa aberta.
      </p>
      <p class="explica">
        Se ele já conversou, o histórico é preservado: o número fica <strong>arquivado</strong>
        em vez de apagado. Nenhuma conversa ou mensagem é perdida.
      </p>
      @if (erroRemocao(); as m) { <p class="erro-geral" role="alert">{{ m }}</p> }
      <div rodape>
        <button type="button" class="btn btn--secundario" (click)="cancelarRemocao()">Cancelar</button>
        <button type="button" class="btn btn--perigo" (click)="remover(confirmandoRemocao()!)" [disabled]="removendo()">
          {{ removendo() ? 'Removendo…' : 'Remover número' }}
        </button>
      </div>
    </ui-modal>
  `,
  styles: `
    :host { display: block; width: 100%; min-width: 0; padding: var(--espacamento-6); }
    .corpo { margin-top: var(--espacamento-4); display: grid; gap: var(--espacamento-3); min-width: 0; }
    .saude { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--espacamento-3); }
    .pessoa { display: grid; gap: 2px; min-width: 0; }
    .nome { color: var(--texto); }
    .tags { display: flex; flex-wrap: wrap; gap: var(--espacamento-1); }
    .carimbo { display: block; margin-top: 2px; font-size: 11px; color: var(--texto-suave); }
    /* ⚠️ Carimbo velho é AVISO, não rodapé: o estado pode estar certo, mas ninguém confirmou. */
    .carimbo.suspeito { color: var(--atencao); }
    .situacao { display: grid; gap: var(--espacamento-2); min-width: 0; max-width: 340px; }
    .err { margin: 0; font-size: 12px; color: var(--erro); }
    .pausado { margin: 0; padding: var(--espacamento-2) var(--espacamento-3); border-radius: var(--raio-controle);
      background: var(--atencao-suave); color: var(--texto); font-size: 12px; line-height: 1.5; }
    .pausado-ok { display: block; color: var(--texto-secundario); }
    .pausado a { display: block; margin-top: 2px; color: var(--acao); text-decoration: none; }
    .pausado a:hover { text-decoration: underline; }
    .aquec { font-size: 12px; color: var(--texto-secundario); }
    .aquec-erro { font-size: 12px; color: var(--erro); }
    .so-admin { margin: 0; font-size: 12px; color: var(--texto-suave); }
    .quando { color: var(--texto-suave); font-size: 12px; }
    .resultado { margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: var(--espacamento-1); font-size: 13px; color: var(--erro); }
    .resultado.ok { color: var(--sucesso); }
    /* flex-wrap: em tela estreita os botões quebram linha em vez de estourar a célula. */
    .acoes { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--espacamento-2); }
    .aviso-faixa { display: flex; flex-wrap: wrap; align-items: center; gap: var(--espacamento-2); margin: 0;
      padding: var(--espacamento-3); border: 1px solid var(--atencao); border-radius: var(--raio-controle);
      background: var(--atencao-suave); color: var(--texto); font-size: 13px; }
    .aviso-faixa--ok { border-color: var(--borda); border-left: 3px solid var(--sucesso); background: var(--superficie); color: var(--texto-secundario); }
    .aviso-risco { display: flex; align-items: flex-start; gap: var(--espacamento-2); margin: 0 0 var(--espacamento-4); padding: var(--espacamento-3);
      border: 1px solid var(--erro); border-radius: var(--raio-controle); background: var(--superficie); color: var(--erro); font-size: 13px; }
    .nota-equipe { margin: 0; padding: var(--espacamento-3); border-left: 3px solid var(--acao);
      background: var(--superficie); border-radius: var(--raio-controle); color: var(--texto-secundario); font-size: 13px; line-height: 1.5; }
    .nota-credencial { margin: 0; padding: var(--espacamento-3); border-left: 3px solid var(--acao); background: var(--superficie);
      border-radius: var(--raio-controle); color: var(--texto-secundario); font-size: 13px; line-height: 1.5; }
    .avancado { border: 1px solid var(--borda); border-radius: var(--raio-controle); background: var(--superficie); }
    .avancado > summary { padding: var(--espacamento-2) var(--espacamento-3); cursor: pointer; font-size: 13px; color: var(--texto-secundario); }
    .avancado > summary:focus-visible { outline: 2px solid var(--borda-foco); outline-offset: 2px; }
    .avancado[open] > summary { border-bottom: 1px solid var(--borda); }
    .avancado > :not(summary) { margin-left: var(--espacamento-3); margin-right: var(--espacamento-3); }
    .avancado > app-formulario-credencial { display: block; margin-bottom: var(--espacamento-3); }
    .aviso-credencial { margin: var(--espacamento-3) 0; font-size: 12px; color: var(--texto-suave); line-height: 1.5; }
    .erro-geral { display: flex; align-items: center; gap: var(--espacamento-2); margin: 0; color: var(--erro); font-size: 13px; }
    .tipo-fixo { margin: 0 0 var(--espacamento-4); font-size: 13px; color: var(--texto-secundario); }
    .explica { margin: 0 0 var(--espacamento-3); font-size: 13px; color: var(--texto-secundario); line-height: 1.5; }
    .qr { padding: var(--espacamento-4); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); text-align: center; }
    .qr img { display: block; margin: 0 auto var(--espacamento-3); border-radius: var(--raio-controle); }
    .qr .passos { margin: 0; font-size: 13px; color: var(--texto); }
    .qr .expira { margin: var(--espacamento-2) 0 0; font-size: 12px; color: var(--texto-suave); }
    /* tabular-nums: sem isso o contador "pula" a cada dígito e a tela treme. */
    .qr .relogio { font-family: var(--tipografia-familia-dados); font-variant-numeric: tabular-nums; color: var(--texto-secundario); }
    .qr .relogio.urgente { color: var(--erro); }
  `,
})
export class CanaisPagina implements OnInit, OnDestroy {
  readonly servico = inject(CanaisServico)
  readonly #http = inject(HttpClient)

  protected readonly colunas: ColunaTabela[] = [
    { chave: 'numero', rotulo: 'Número' },
    { chave: 'tipo', rotulo: 'Tipo' },
    { chave: 'agente', rotulo: 'Agente', largura: '160px' },
    { chave: 'estado', rotulo: 'Estado', largura: '150px' },
    { chave: 'situacao', rotulo: 'Situação' },
    { chave: 'acoes', rotulo: 'Ações', alinhamento: 'dir', largura: '300px' },
  ]
  /** A API de canais devolve a frota inteira (sem cursor): a tabela não tem paginação. */
  protected readonly linhas = computed(() => this.servico.canais() as unknown as readonly LinhaTabela[])
  protected readonly opcoesProvedores = computed<OpcaoSelect[]>(() =>
    this.servico.provedores().map((p) => ({ valor: p.codigo, rotulo: p.nome })))

  /** `id` presente = EDITANDO um número que existe; ausente = conectando um novo. */
  readonly editando = signal<{ id?: string; provedor: string; nome: string } | null>(null)
  readonly confirmandoRemocao = signal<Canal | null>(null)
  readonly removendo = signal(false)
  readonly erroRemocao = signal<string | null>(null)
  readonly avisoRemocao = signal<string | null>(null)
  readonly credencial = signal<Record<string, string>>({})
  readonly erros = signal<Record<string, string>>({})
  readonly erroGeral = signal<string | null>(null)
  readonly salvando = signal(false)
  readonly resultado = signal<Record<string, { conectado: boolean; detalhe?: string }>>({})
  /** Hora da última verificação, por canal — o carimbo ao lado do estado. */
  readonly verificadoEm = signal<Record<string, string>>({})
  /** Segundos até o QR atual expirar, por canal. */
  readonly restante = signal<Record<string, number>>({})
  readonly #timers = new Map<string, ReturnType<typeof setInterval>>()
  /**
   * ⚠️ Relógio da tela. Sem ele, "verificado há 3 min" ficaria congelado numa
   * aba aberta 8 horas. Meio minuto basta: a menor unidade exibida é o minuto.
   */
  readonly agora = signal(new Date())
  #relogio: ReturnType<typeof setInterval> | null = null
  #polling: ReturnType<typeof setTimeout> | null = null
  #destruida = false
  #paradoDesde = new Map<string, { chave: string; desde: number }>()
  readonly qr = signal<Record<string, { imagem?: string; erro?: string }>>({})
  readonly buscandoQr = signal<string | null>(null)
  /** Canal cujo QR está no modal de reconexão; `null` = modal fechado. */
  readonly qrCanalId = signal<string | null>(null)

  /** Abre o modal de QR e busca o primeiro código. */
  abrirQr(canalId: string): void {
    this.qrCanalId.set(canalId)
    void this.pedirQr(canalId)
  }

  gerarOutroQr(): void {
    const id = this.qrCanalId()
    if (id) void this.pedirQr(id)
  }

  /**
   * Fechar o modal encerra a sessão de pareamento: sem a tela aberta ninguém
   * escaneia, e o relógio não tem por que continuar batendo no fornecedor.
   */
  fecharQr(): void {
    const id = this.qrCanalId()
    this.qrCanalId.set(null)
    if (!id) return
    this.#encerrarSessao(id)
    this.qr.update((a) => ({ ...a, [id]: {} }))
  }

  /**
   * Busca o QR sob demanda. ⚠️ Nunca guardado: o código expira em segundos e
   * muda a cada leitura — servir um QR salvo seria servir um código morto.
   */
  async pedirQr(canalId: string): Promise<void> {
    this.buscandoQr.set(canalId)
    try {
      const r = await firstValueFrom(
        this.#http.get<{ imagem: string }>(`/v1/canais/${canalId}/qrcode`))
      this.qr.update((a) => ({ ...a, [canalId]: { imagem: r.imagem } }))
      // ⚠️ Detecta a conexão sozinho enquanto o QR está aberto. Pedir ao usuário
      //    que clique em "testar" depois de escanear é obrigá-lo a confirmar algo
      //    que o sistema pode descobrir — e a leitura do QR não avisa ninguém.
      this.#abrirSessaoPareamento(canalId)
    } catch (e) {
      this.qr.update((a) => ({ ...a, [canalId]: { erro: this.#mensagemQr(e) } }))
      // ⚠️ 403: o papel mudou durante a sessão. Relê a frota para o botão
      //    sumir — a tela passa a mostrar só o estado.
      if (e instanceof HttpErrorResponse && e.status === 403) void this.servico.atualizar()
    } finally {
      this.buscandoQr.set(null)
    }
  }

  /** O canal que está sendo editado — para saber o nome original e o que já tem credencial. */
  readonly canalEditado = computed(() => {
    const ed = this.editando()
    return ed?.id ? (this.servico.canais().find((c) => c.id === ed.id) ?? null) : null
  })
  /**
   * Quais campos já têm valor guardado.
   *
   * ⚠️ Só os NOMES chegam da API — valor de credencial não volta (§5.8) — e a
   * tela traduz para o RÓTULO do formulário: "clientToken" é o nome interno,
   * mas o que está escrito no campo logo abaixo é "Token de segurança
   * (Client-Token)". Listar o nome interno obriga a pessoa a adivinhar a
   * correspondência.
   */
  readonly camposConfigurados = computed(() => {
    const campos = this.provedorAtual()?.esquemaCredencial.campos ?? []
    return (this.canalEditado()?.credencial.camposPreenchidos ?? [])
      .map((nome) => campos.find((c) => c.nome === nome)?.rotulo ?? nome)
  })

  readonly provedorAtual = computed(() => {
    const ed = this.editando()
    return ed ? this.servico.provedores().find((p) => p.codigo === ed.provedor) : undefined
  })

  /** Quem abriu a área da equipe no clique. A regra de exibição é `abrirAvancado`. */
  readonly avancadoManual = signal(false)
  readonly avancadoAberto = computed(() =>
    abrirAvancado(
      this.erros(),
      this.provedorAtual()?.esquemaCredencial.campos.map((c) => c.nome) ?? [],
      this.avancadoManual(),
    ))

  /**
   * ⚠️ `preventDefault` porque o `<details>` alterna sozinho no clique: sem
   * isso o DOM abre e o binding `[open]` fecha de volta no mesmo instante.
   */
  alternarAvancado(e: Event): void {
    e.preventDefault()
    this.avancadoManual.update((v) => !v)
  }

  ngOnInit(): void {
    this.#relogio = setInterval(() => this.agora.set(new Date()), 30_000)
    void this.servico.carregar().then(() => {
      // Aquecimento por número (só faz sentido no não-oficial).
      for (const c of this.servico.canais()) {
        if (c.tipo !== 'whatsapp_oficial') void this.servico.carregarAquecimento(c.id)
      }
      this.#agendarPolling()
    })
  }

  pct(taxa: number | null): string { return taxa === null ? '—' : `${Math.round(taxa * 100)}%` }
  valorEntrega(e: { amostras: number; taxa: number | null }): string {
    return e.amostras === 0 ? '—' : this.pct(e.taxa)
  }
  rotuloEntrega(e: { amostras: number; falha: number }): string {
    return e.amostras === 0 ? 'Entrega (24h) · sem envios' : `Entrega (24h) · ${e.falha} falhas de ${e.amostras}`
  }
  tomEntrega(e: { amostras: number; taxa: number | null }): TomStat {
    if (e.amostras === 0) return 'neutro'
    return (e.taxa ?? 1) < 0.7 ? 'erro' : 'sucesso'
  }

  ehOficial(c: Canal): boolean { return c.tipo === 'whatsapp_oficial' }
  nomeProvedor(cod: string | null): string {
    return this.servico.provedores().find((p) => p.codigo === cod)?.nome ?? (cod ?? '—')
  }
  /** Texto do carimbo — a regra é pura e testada em `canais.regras.ts`. */
  carimbo(c: Canal): string { return idadeVerificacao(c.verificadoEm, this.agora()) }
  carimboSuspeito(c: Canal): boolean { return verificacaoAtrasada(c.verificadoEm, this.agora()) }

  rotuloEstado(e: string): string {
    return e === 'conectado' ? 'Conectado' : e === 'desconectado' ? 'Desconectado' : 'Aguardando teste'
  }

  abrir(): void {
    this.limpar()
    this.editando.set({ provedor: this.servico.provedores()[0]?.codigo ?? '', nome: '' })
  }
  abrirEdicao(c: Canal): void {
    this.limpar()
    this.avisoRemocao.set(null)
    this.editando.set({ id: c.id, provedor: c.provedor ?? '', nome: c.nomeAmigavel })
  }
  tituloEdicao(): string { return this.editando()?.id ? 'Editar número' : 'Conectar número' }

  pedirRemocao(c: Canal): void {
    this.erroRemocao.set(null)
    this.avisoRemocao.set(null)
    this.confirmandoRemocao.set(c)
  }
  tituloRemocao(): string { return `Remover ${this.confirmandoRemocao()?.nomeAmigavel ?? 'número'}?` }
  cancelarRemocao(): void { this.confirmandoRemocao.set(null); this.erroRemocao.set(null) }

  async remover(c: Canal): Promise<void> {
    this.removendo.set(true)
    this.erroRemocao.set(null)
    try {
      const r = await this.servico.remover(c.id)
      if (!r.ok) { this.erroRemocao.set(r.erro.mensagem); return }
      this.confirmandoRemocao.set(null)
      // O texto do desfecho é regra pura (e testada) em `canais.regras.ts`.
      this.avisoRemocao.set(avisoDeRemocao(c.nomeAmigavel, r.estado, r.conversas))
    } finally {
      this.removendo.set(false)
    }
  }

  fechar(): void { this.editando.set(null); this.limpar() }
  private limpar(): void {
    this.credencial.set({}); this.erros.set({}); this.erroGeral.set(null)
    this.avancadoManual.set(false)
  }

  trocarProvedor(codigo: string): void {
    // ⚠️ Trocar de provedor limpa a credencial: os campos são outros.
    this.credencial.set({}); this.erros.set({}); this.avancadoManual.set(false)
    this.editando.update((ed) => (ed ? { ...ed, provedor: codigo } : ed))
  }
  nomeMudou(nome: string): void {
    this.editando.update((ed) => (ed ? { ...ed, nome } : ed))
  }
  credencialMudou(v: Record<string, string>): void { this.credencial.set(v) }

  async salvar(): Promise<void> {
    const ed = this.editando()
    if (!ed) return
    this.salvando.set(true); this.erros.set({}); this.erroGeral.set(null)
    try {
      if (ed.id) { await this.#salvarEdicao(ed.id, ed.nome); return }
      const r = await this.servico.criar({ provedor: ed.provedor, nomeAmigavel: ed.nome, credencial: this.credencial() })
      if (!r.ok) {
        this.erros.set(r.erro.detalhe?.campos ?? (r.erro.detalhe?.campo ? { [r.erro.detalhe.campo]: r.erro.mensagem } : {}))
        if (!r.erro.detalhe?.campos && !r.erro.detalhe?.campo) this.erroGeral.set(r.erro.mensagem)
        return
      }
      this.editando.set(null); this.limpar()
      // Salvar e testar num gesto só — salvar sem testar deixa achando que conectou.
      await this.testar({ id: r.id } as Canal)
    } finally {
      this.salvando.set(false)
    }
  }

  /**
   * ⚠️ Só o que MUDOU viaja: campo de credencial em branco significa "mantém",
   * e o nome só vai se foi editado — senão toda abertura do modal gravaria uma
   * alteração na auditoria sem nada ter mudado.
   */
  async #salvarEdicao(id: string, nome: string): Promise<void> {
    const r = await this.servico.editar(
      id, mudancasDaEdicao(nome, this.canalEditado()?.nomeAmigavel ?? '', this.credencial()))
    if (!r.ok) {
      this.erros.set(r.erro.detalhe?.campos ?? (r.erro.detalhe?.campo ? { [r.erro.detalhe.campo]: r.erro.mensagem } : {}))
      if (!r.erro.detalhe?.campos && !r.erro.detalhe?.campo) this.erroGeral.set(r.erro.mensagem)
      return
    }
    this.editando.set(null); this.limpar()
    // ⚠️ Credencial trocada devolve o canal para 'conectando' no servidor:
    //    testar no mesmo gesto evita deixar a tela afirmando um estado que
    //    ninguém conferiu — o mesmo motivo do "salvar e testar" do cadastro.
    if (r.credencialTrocada) await this.testar({ id } as Canal)
  }

  /**
   * A SESSÃO DE PAREAMENTO — um relógio só para as três coisas que acontecem
   * enquanto o QR está na tela: contar o tempo, renovar o código e perceber que
   * pareou.
   *
   * ⚠️ **O QR expira em segundos.** Sem renovar sozinho, o usuário escaneia um
   * código morto e não entende por que não funcionou.
   *
   * ⚠️ E não renova para sempre: uma aba esquecida bateria no fornecedor a noite
   * inteira. Ao estourar o teto a tela DIZ que parou, em vez de simplesmente
   * deixar de funcionar em silêncio.
   */
  #abrirSessaoPareamento(canalId: string): void {
    this.#encerrarSessao(canalId)
    let segundos = 0
    let renovacoes = 0

    const timer = setInterval(() => {
      segundos++

      // QR fechado (pareou, fechou o modal, trocou de tela): o relógio morre junto.
      if (!this.qr()[canalId]?.imagem) { this.#encerrarSessao(canalId); return }

      this.restante.update((a) => ({
        ...a, [canalId]: SEGUNDOS_QR - (segundos % SEGUNDOS_QR),
      }))

      // A cada 3s (o mesmo passo do polling rápido): já pareou? A leitura do
      // QR não avisa ninguém — o fornecedor precisa ser perguntado.
      if (segundos % (POLL_RAPIDO_MS / 1000) === 0) {
        void this.servico.testar(canalId).then((r) => {
          this.resultado.update((a) => ({ ...a, [canalId]: r }))
          this.#carimbar(canalId)
          if (r.conectado) {
            this.#encerrarSessao(canalId)
            this.qr.update((a) => ({ ...a, [canalId]: {} }))
            // Pareou: o modal de QR não tem mais o que mostrar.
            if (this.qrCanalId() === canalId) this.qrCanalId.set(null)
            void this.servico.atualizar()
          }
        })
      }

      // Expirou: busca outro, até o teto.
      if (segundos % SEGUNDOS_QR === 0) {
        if (++renovacoes > MAX_RENOVACOES) {
          this.#encerrarSessao(canalId)
          this.qr.update((a) => ({
            ...a, [canalId]: { erro: 'A sessão de pareamento expirou. Gere um novo QR.' },
          }))
          return
        }
        void this.#buscarQr(canalId)
      }
    }, 1000)

    this.#timers.set(canalId, timer)
    // QR na tela = alguém esperando: o polling passa a 3 s já, sem esperar
    // o fim do intervalo lento que estava agendado.
    this.#agendarPolling()
  }

  /** Busca uma imagem nova de QR e reinicia o contador. */
  async #buscarQr(canalId: string): Promise<boolean> {
    try {
      const r = await firstValueFrom(
        this.#http.get<{ imagem: string }>(`/v1/canais/${canalId}/qrcode`))
      this.qr.update((a) => ({ ...a, [canalId]: { imagem: r.imagem } }))
      this.restante.update((a) => ({ ...a, [canalId]: SEGUNDOS_QR }))
      return true
    } catch (e) {
      this.qr.update((a) => ({ ...a, [canalId]: { erro: this.#mensagemQr(e) } }))
      // ⚠️ 403 na RENOVAÇÃO: o papel foi retirado com o QR aberto. A sessão
      //    acaba aqui (nada de seguir testando/renovando) e a frota é relida
      //    para o botão sumir.
      if (e instanceof HttpErrorResponse && e.status === 403) {
        this.#encerrarSessao(canalId)
        void this.servico.atualizar()
      }
      return false
    }
  }

  /** Texto da falha do QR — a regra é pura e testada (`mensagemFalhaQr`). */
  #mensagemQr(e: unknown): string {
    if (!(e instanceof HttpErrorResponse)) return mensagemFalhaQr(0, null, false)
    const corpo = e.error as { mensagem?: unknown } | null
    return mensagemFalhaQr(e.status, typeof corpo?.mensagem === 'string' ? corpo.mensagem : null, corpoDaApi(e.error))
  }

  #encerrarSessao(canalId: string): void {
    const t = this.#timers.get(canalId)
    if (t) { clearInterval(t); this.#timers.delete(canalId) }
  }

  /** ⚠️ Sair da tela mata todos os relógios — nenhum sobrevive à navegação. */
  ngOnDestroy(): void {
    this.#destruida = true
    for (const t of this.#timers.values()) clearInterval(t)
    this.#timers.clear()
    if (this.#relogio) { clearInterval(this.#relogio); this.#relogio = null }
    if (this.#polling) { clearTimeout(this.#polling); this.#polling = null }
  }

  /**
   * POLLING POR ESTADO (P10): relê a frota em 3 s enquanto alguém espera (QR
   * aberto, número conectando) e em 30 s no resto — `intervaloDePolling`.
   *
   * ⚠️ setTimeout re-agendado, não setInterval: o próximo intervalo é decidido
   * DEPOIS da resposta, com o estado novo — e uma resposta lenta nunca empilha
   * com a seguinte. Para ao sair da tela.
   */
  #agendarPolling(): void {
    if (this.#destruida) return
    if (this.#polling) { clearTimeout(this.#polling); this.#polling = null }
    // ⚠️ Sem permissão não reagenda: insistir não muda a resposta.
    if (this.servico.estado() === 'sem_permissao') return
    const ms = intervaloDePolling(this.#observar(Date.now()), this.#timers.size > 0, this.servico.falhasSeguidas())
    this.#polling = setTimeout(() => {
      this.#polling = null
      void this.servico.atualizar().finally(() => this.#agendarPolling())
    }, ms)
  }

  /**
   * Há quanto tempo cada número está PARADO (mesmo estado, mesmo carimbo).
   * Mudou qualquer um dos dois → o relógio do número recomeça. É o que deixa
   * `intervaloDePolling` largar o modo rápido de um `conectando` esquecido.
   */
  #observar(agoraMs: number): { estado: string; paradoHaMs: number }[] {
    const vistos = new Map<string, { chave: string; desde: number }>()
    const obs = this.servico.canais().map((c) => {
      const chave = `${c.estado}|${c.verificadoEm ?? ''}`
      const antes = this.#paradoDesde.get(c.id)
      const desde = antes && antes.chave === chave ? antes.desde : agoraMs
      vistos.set(c.id, { chave, desde })
      return { estado: c.estado, paradoHaMs: agoraMs - desde }
    })
    this.#paradoDesde = vistos
    return obs
  }

  /** The stored reason ("qualidade:FLAGGED") in the operator's words — never the raw code. */
  readonly rotuloSuspensao = rotuloSuspensao
  hora(d: Date): string { return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) }
  dataHora(iso: string): string {
    return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  }
  rotuloModo(modo: string | undefined): string { return rotuloModoAgente(modo) }
  seloModo(c: Canal): { rotulo: string; dica: string } | null { return seloRestricaoModo(c.modoAgenteOrigem, c.modoAgenteNumero) }

  #carimbar(canalId: string): void {
    const agora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    this.verificadoEm.update((a) => ({ ...a, [canalId]: `às ${agora}` }))
  }

  async testar(c: Canal): Promise<void> {
    const r = await this.servico.testar(c.id)
    this.resultado.update((a) => ({ ...a, [c.id]: r }))
    // ⚠️ O carimbo é do momento da RESPOSTA, não do clique: o que interessa é
    //    quando o fornecedor confirmou, não quando alguém pediu.
    this.#carimbar(c.id)
  }
}
