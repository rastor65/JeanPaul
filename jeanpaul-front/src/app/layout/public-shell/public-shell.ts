import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink, RouterOutlet } from '@angular/router';
import { Observable } from 'rxjs';

import { ReserveModalComponent } from '../../shared/reserve-modal/reserve-modal';
import { ToastComponent } from '../../shared/toast/toast.component';
import { ReserveUiService } from '../../shared/reserve-ui.service';

@Component({
  selector: 'app-public-shell',
  standalone: true,
  imports: [CommonModule, RouterOutlet, RouterLink, ReserveModalComponent, ToastComponent],
  templateUrl: './public-shell.html',
  styleUrl: './public-shell.scss'
})
export class PublicShellComponent {
  private reserveUi = inject(ReserveUiService);

  year = new Date().getFullYear();
  showReserve$: Observable<boolean> = this.reserveUi.open$;

  openReserve() { this.reserveUi.open(); }
  closeReserve() { this.reserveUi.close(); }
}
