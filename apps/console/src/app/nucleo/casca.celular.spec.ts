import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { CAMADA } from './casca.regras.js'

/**
 * A casca no celular liga as regras puras (casca.regras.ts) ao template. Estes
 * testes leem o fonte para garantir que a ligação existe — as regras sozinhas
 * passam verdes mesmo se o template não as usar.
 */
const app = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ler = (rel: string) => readFileSync(resolve(app, rel), 'utf8')
const casca = ler('nucleo/shell.componente.ts')
const trilho = ler('funcionalidades/atendimento/chat-rail.componente.ts')
const inbox = ler('funcionalidades/atendimento/inbox.pagina.ts')

/** Regras CSS com position: fixed e o z-index delas (null = sem z-index). */
function fixosSemCamada(dir: string, achados: string[] = []): string[] {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) { fixosSemCamada(resolve(dir, ent.name), achados); continue }
    if (!ent.name.endsWith('.ts') || ent.name.endsWith('.spec.ts')) continue
    // A casca e o trilho são donos das camadas abaixo dos modais.
    if (ent.name === 'shell.componente.ts' || ent.name === 'chat-rail.componente.ts') continue
    const src = readFileSync(resolve(dir, ent.name), 'utf8')
    for (const m of src.matchAll(/([^{}]*)\{([^{}]*position:\s*fixed[^{}]*)\}/g)) {
      const z = /z-index:\s*(\d+)/.exec(m[2] ?? '')
      const seletor = (m[1] ?? '').trim().split('\n').pop()?.trim()
      if (!z || Number(z[1]) < CAMADA.modal) achados.push(`${ent.name}: '${seletor}' z-index ${z?.[1] ?? 'ausente'}`)
    }
  }
  return achados
}

describe('⚠️ Botão flutuante de conversas × modais das telas', () => {
  it('a camada do trilho vem de camadaTrilho(), não de número fixo acima dos modais', () => {
    expect(casca).toContain('[style.--z-trilho]="zTrilho()"')
    expect(casca).toMatch(/app-chat-rail\s*\{[^}]*z-index:\s*var\(--z-trilho/)
  })

  it('todo elemento fixo de tela (modal, fundo, painel) fica no piso dos modais ou acima — cobre o botão', () => {
    const achados = fixosSemCamada(app)
    expect(
      achados,
      `position: fixed abaixo de ${CAMADA.modal} fica SOB o botão flutuante 💬 (z ${CAMADA.trilhoRecolhido}) no celular:\n`
      + achados.join('\n'),
    ).toEqual([])
  })
})

describe('Gaveta fecha ao escolher um item do menu', () => {
  it('⚠️ todo link da gaveta fecha ao tocar — tocar na rota ATUAL não gera NavigationEnd', () => {
    const gaveta = casca.slice(casca.indexOf('<aside'), casca.indexOf('</aside>'))
    const links = gaveta.match(/<a\s[^>]*routerLink[^>]*>/g) ?? []
    expect(links.length).toBeGreaterThan(1)
    for (const a of links) expect(a, a).toContain("mudarGaveta('navegou')")
  })
})

describe('Um título só e um ‹ por nível no trilho', () => {
  it('o trilho não tem cabeçalho próprio nem botão de modo (empurrar × gaveta é pela largura)', () => {
    expect(trilho).not.toContain('voltar-trilho')
    expect(trilho).not.toContain('class="cab"')
    expect(trilho).not.toContain('alternarSobrepor')
  })

  it('fechar mora no cabeçalho da lista do inbox, pela regra; o ‹ da conversa volta à lista', () => {
    expect(inbox).toContain('fecharNoCabecalhoDaLista(this.celular(), this.noTrilho())')
    expect(inbox).toMatch(/class="voltar fechar-trilho" \(click\)="servico\.fecharRail\(\)"/)
    expect(inbox).toMatch(/class="recolher" type="button" \(click\)="servico\.fecharRail\(\)"/)
    expect(inbox).toMatch(/class="voltar" \(click\)="servico\.voltarParaLista\(\)"/)
    expect(trilho).toContain('[noTrilho]="true"')
  })
})

describe('Empurrar × gaveta é decidido pela casca, pela largura', () => {
  it('a casca passa o modo e a largura limitada ao trilho', () => {
    expect(casca).toContain('[modo]="modoTrilho()" [largura]="larguraTrilho()"')
    expect(casca).toContain('modoTrilho(this.larguraJanela()')
  })

  it('"Conversas" no menu é alternador (aria-pressed), nunca o .ativo de rota', () => {
    expect(casca).toContain('class="item alternador" [attr.aria-pressed]="inbox.railAberto()"')
    expect(casca).not.toContain('[class.ativo]="inbox.railAberto()"')
  })
})

describe('Trilho em tela cheia se comporta como diálogo', () => {
  it('⚠️ topo e conteúdo ficam inert com o trilho aberto no celular (não só com a gaveta)', () => {
    expect(casca).toContain('<header class="topo" [attr.inert]="atrasInerte() ? \'\' : null">')
    expect(casca).toContain('<div class="conteudo" [attr.inert]="conteudoInerte() ? \'\' : null">')
    expect(casca).toContain('conteudoInerte(this.celular(), this.gavetaAberta(), this.inbox.railAberto())')
  })

  it('⚠️ com o trilho em GAVETA no desktop o conteúdo também fica inert (o topo não)', () => {
    expect(casca).toContain("this.celular(), this.gavetaAberta(), this.inbox.railAberto(), this.modoTrilho() === 'gaveta')")
  })

  it('o trilho em tela cheia ou em gaveta se anuncia como diálogo modal, com Esc e foco preso', () => {
    expect(trilho).toContain('[attr.role]="modal() ? \'dialog\' : null"')
    expect(trilho).toContain('[attr.aria-modal]="modal() ? \'true\' : null"')
    expect(trilho).toContain("ev.key === 'Escape'")
    expect(trilho).toContain('prenderTab(this.painel().nativeElement')
  })
})
