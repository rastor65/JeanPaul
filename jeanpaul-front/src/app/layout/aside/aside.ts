import { Component, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { UiStateService } from '../../core/ui/ui-state.service';

type IconKey = 'home' | 'agenda' | 'appointments' | 'customers' | 'settings';

type NavItem = {
  label: string;
  link: string;
  icon: IconKey;
  exact?: boolean;
};

@Component({
  selector: 'app-aside',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './aside.html',
  styleUrl: './aside.scss',
})
export class AsideComponent {
  private ui = inject(UiStateService);

  collapsed = computed(() => this.ui.sidebarCollapsed());

  items: NavItem[] = [
    { label: 'Inicio', link: '/app', icon: 'home', exact: true },
    { label: 'Agenda', link: '/app/agenda', icon: 'agenda' },
    { label: 'Turnos', link: '/app/appointments', icon: 'appointments' },
    { label: 'Clientes', link: '/app/customers', icon: 'customers' },
    { label: 'Ajustes', link: '/app/settings', icon: 'settings' },
  ];

  toggleSidebar() {
    this.ui.toggleSidebar();
  }

  iconPath(key: IconKey): string {
    switch (key) {
      case 'home':
        return 'M3 10.5 12 3l9 7.5V21a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1V10.5z';
      case 'agenda':
        return 'M7 2v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2V2h-2v2H9V2H7zm14 8H3v10a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V10z';
      case 'appointments':
        return 'M7 4h10v2H7V4zm-2 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2zm2 3v2h4v-2H7zm0 4v2h7v-2H7z';
      case 'customers':
        return 'M16 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0zm-14 11a6 6 0 0 1 12 0H2zm13.5 0a5.5 5.5 0 0 1 10.5 0H15.5z';
      case 'settings':
        return 'M12 8.5A3.5 3.5 0 1 0 12 15.5 3.5 3.5 0 0 0 12 8.5zm9.4 3.1-.9-.5.1-1.1-1.7-2.9-1.1.3-.8-.7-.3-1.1H8.3L8 5.6l-.8.7-1.1-.3-1.7 2.9.1 1.1-.9.5v3.8l.9.5-.1 1.1 1.7 2.9 1.1-.3.8.7.3 1.1h7.4l.3-1.1.8-.7 1.1.3 1.7-2.9-.1-1.1.9-.5v-3.8z';
      default:
        return '';
    }
  }

  titleFor(label: string): string | null {
    return this.collapsed() ? label : null;
  }
}
