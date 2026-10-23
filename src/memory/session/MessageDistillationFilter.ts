import { SessionMessage } from '../../domain/memory/session-types';

/**
 * MessageDistillationFilter - Фильтр сообщений перед дистилляцией.
 * Исключает шум (приветствия, технические подтверждения) для экономии токенов Mem0.
 */
export class MessageDistillationFilter {
    private static readonly NOISE_PATTERNS = [
        /^(hi|hello|hey|greetings)$/i,
        /^(ok|okay|thanks|thank you|thx|fine|yes|no)$/i,
        /^(typing\.\.\.|wait|hold on)$/i,
    ];

    /**
     * Фильтрует список сообщений, оставляя только те, которые несут семантическую нагрузку.
     */
    static filter(messages: SessionMessage[]): SessionMessage[] {
        return messages.filter(m => {
            // Оставляем системные сообщения (часто содержат важные инструкции)
            if (m.role === 'system') return true;

            // Оставляем сообщения инструментов
            if (m.role === 'tool') return true;

            const content = m.content.trim();
            
            // Исключаем пустые или слишком короткие (менее 2 символов)
            if (content.length < 2) return false;

            // Проверяем на паттерны "шума"
            const isNoise = this.NOISE_PATTERNS.some(pattern => pattern.test(content));
            if (isNoise) return false;

            return true;
        });
    }

    /**
     * Возвращает true, если сообщение содержит признаки смены темы (Semantic Drift).
     * Упрощенная реализация: проверяет наличие вопросительных слов или ключевых фраз.
     */
    static hasSemanticDrift(content: string): boolean {
        const text = content.toLowerCase();
        const indicators = [
            'кстати', 'новое задание', 'другой вопрос', 'забудь', 
            'by the way', 'new task', 'another question', 'forget about'
        ];
        return indicators.some(ind => text.includes(ind));
    }
}
