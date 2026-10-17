import { Component, ChangeDetectionStrategy, inject, signal, computed, OnInit } from '@angular/core'
import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { firstValueFrom } from 'rxjs'
import { textoAvisoPrivacidade } from '@geracrm/shared'

interface Privacidade {
  readonly url: string | null; readonly versao: string; readonly textoPadrao: string | null
  readonly configurada: boolean; readonly previa: string
}
type Estado = 'carregando' | 'pronto' | 'erro'

/**
 * AVISO DE PRIVACIDADE (raia P4) — seção própria das Configurações Gerais.
 *
 * O que o agente exibe na ABERTURA de toda conversa (e o que o vendedor cola,
 * P13): link, versão e texto. Cada exibição fica registrada por contato com a
 * versão vigente — por isso trocar o texto pede versão nova.
 *
 * ⚠️ Estado próprio: se esta seção falhar, a tela de configurações não cai.
 * ⚠️ Gravar é de admin (403 vira texto nomeado, não "erro"). A prévia usa a
 *    MESMA função do servidor (`@geracrm/shared`) — o que se vê é o que sai.
 */
@Component({
  selector: 'app-privacidade',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="painel">
      <h2 class="txt-secao">Aviso de privacidade</h2>
      <p class="dica">Vai no fim da apresentação do agente, na primeira mensagem de cada conversa. Cada exibição fica registrada no contato, com a versão.</p>
      @switch (estado()) {
        @case ('carregando') { <div class="esq" aria-hidden="true"></div> }
        @case ('erro') {
          <p class="vazio">Não foi possível carregar o aviso de privacidade.
            <button class="btn btn--secundario" type="button" (click)="carregar()">Tentar de novo</button></p>
        }
        @case ('pronto') {
          <form class="form" (submit)="salvar($event)">
            <label class="campo">Link da política de privacidade
              <input type="url" inputmode="url" [value]="url()" (input)="url.set($any($event.target).value)"
                     placeholder="https://suaempresa.com.br/privacidade" />
            </label>
            <label class="campo">Texto do aviso
              <textarea rows="2" maxlength="500" [value]="texto()" (input)="texto.set($any($event.target).value)"
                        placeholder="Esta conversa fica registrada para te atender melhor."></textarea>
            </label>
            <label class="campo">Versão
              <input class="txt-dados" maxlength="40" [value]="versao()" (input)="versao.set($any($event.target).value)" placeholder="padrao" />
            </label>
            <div class="previa">
              <span class="txt-rotulo">Como o cliente vê</span>
              <p class="previa-texto">{{ previa() }}</p>
            </div>
            <div class="acoes">
              <button class="btn btn--primario" type="submit" [disabled]="salvando()">{{ salvando() ? 'Salvando…' : 'Salvar aviso' }}</button>
              @if (msg(); as m) { <span [class.ok]="m.ok" [class.falha]="!m.ok" role="status">{{ m.texto }}</span> }
            </div>
          </form>
        }
      }
    </section>
  `,
  styles: `
    :host { display: block; }
    .painel { padding: var(--espacamento-4) var(--espacamento-6); border: 1px solid var(--borda); border-radius: var(--raio-painel); background: var(--superficie-elevada); margin-bottom: var(--espacamento-4); }
    .painel h2 { margin: 0 0 var(--espacamento-2); }
    .dica { margin: 0 0 var(--espacamento-3); color: var(--texto-secundario); font-size: 13px; }
    .esq { height: 160px; border-radius: var(--raio-controle); background: var(--superficie); }
    .vazio { color: var(--texto-suave); font-size: 13px; margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: var(--espacamento-3); }
    .form { display: grid; gap: var(--espacamento-3); max-width: 520px; min-width: 0; }
    .campo { display: flex; flex-direction: column; gap: var(--espacamento-2); color: var(--texto); font-size: 13px; min-width: 0; }
    .campo input, .campo textarea { padding: var(--espacamento-2) var(--espacamento-3); border: 1px solid var(--borda-controle); border-radius: var(--raio-controle); background: var(--fundo); color: var(--texto); font: inherit; min-width: 0; }
    .previa { display: grid; gap: var(--espacamento-1); padding: var(--espacamento-3); border: 1px solid var(--borda); border-radius: var(--raio-controle); background: var(--superficie); }
    .previa-texto { margin: 0; color: var(--texto); font-size: 13px; overflow-wrap: anywhere; }
    .acoes { display: flex; flex-wrap: wrap; align-items: center; gap: var(--espacamento-3); }
    .ok { color: var(--sucesso); font-size: 13px; }
    .falha { color: var(--erro); font-size: 13px; }
  `,
})
export class PrivacidadeComponente implements OnInit {
  private readonly http = inject(HttpClient)
  readonly estado = signal<Estado>('carregando')
  readonly url = signal(''); readonly texto = signal(''); readonly versao = signal('padrao')
  readonly salvando = signal(false)
  readonly msg = signal<{ ok: boolean; texto: string } | null>(null)
  readonly previa = computed(() => textoAvisoPrivacidade({ url: this.url(), textoPadrao: this.texto() }))

  ngOnInit(): void { void this.carregar() }

  async carregar(): Promise<void> {
    this.estado.set('carregando')
    try {
      this.aplicar(await firstValueFrom(this.http.get<Privacidade>('/v1/privacidade')))
      this.estado.set('pronto')
    } catch { this.estado.set('erro') }
  }

  async salvar(ev: Event): Promise<void> {
    ev.preventDefault()
    if (this.salvando()) return
    this.salvando.set(true); this.msg.set(null)
    try {
      const r = await firstValueFrom(this.http.put<Privacidade>('/v1/privacidade', {
        url: this.url().trim(), versao: this.versao().trim(), textoPadrao: this.texto().trim(),
      }))
      this.aplicar(r)
      this.msg.set({ ok: true, texto: 'Aviso salvo.' })
    } catch (e) {
      // ⚠️ Preserva o que foi digitado: só a mensagem muda.
      const err = e instanceof HttpErrorResponse ? e : null
      const texto = err?.status === 403 ? 'Só administradores alteram o aviso de privacidade.'
        : err?.status === 422 && typeof err.error?.mensagem === 'string' ? err.error.mensagem
        : 'Não foi possível salvar. Tente de novo.'
      this.msg.set({ ok: false, texto })
    } finally { this.salvando.set(false) }
  }

  private aplicar(p: Privacidade): void {
    this.url.set(p.url ?? ''); this.texto.set(p.textoPadrao ?? ''); this.versao.set(p.versao)
  }
}
