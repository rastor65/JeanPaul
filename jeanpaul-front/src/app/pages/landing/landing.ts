import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { Observable } from 'rxjs';
import { ReserveUiService } from '../../shared/reserve-ui.service';

@Component({
  selector: 'app-landing',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './landing.html',
  styleUrl: './landing.scss',
})
export class LandingComponent {
  private reserveUi = inject(ReserveUiService);

  // Para ocultar el sticky CTA cuando el modal está abierto
  reserveOpen$: Observable<boolean> = this.reserveUi.open$;

  openReserve(): void {
    this.reserveUi.open();
  }
}
