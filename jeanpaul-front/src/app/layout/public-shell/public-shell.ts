import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink, RouterOutlet } from '@angular/router';
import { ReserveModalComponent } from '../../shared/reserve-modal/reserve-modal';
import { ToastComponent } from '../../shared/toast/toast.component';

@Component({
  selector: 'app-public-shell',
  standalone: true,
  imports: [CommonModule, RouterOutlet, RouterLink, ReserveModalComponent, ToastComponent],
  templateUrl: './public-shell.html',
  styleUrl: './public-shell.scss'
})
export class PublicShellComponent {
  year = new Date().getFullYear();
  showReserve = false;

  openReserve() { this.showReserve = true; }
  closeReserve() { this.showReserve = false; }
}
