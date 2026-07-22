---
name: exam-to-quiz
kind: tool-usage
description: 라이브러리 시험지 PDF → 퀴즈 렌더. 태그 - 시험지, 문제지, 기출, 퀴즈로, 문제 풀기, exam, quiz, 객관식, 보기. 라이브러리에 올린 시험지/문제지를 문항·보기로 구조화해 quiz_group 으로 보여줄 때 get_skill 로 본문을 읽고 그대로 따를 것.
---

# 라이브러리 시험지 → quiz 렌더 (library_extract_structured)

시험지는 2단·보기 그리드라 텍스트 파싱(Document Parse)은 reading-order 가 꼬여 보기 순서가
틀린다. **`library_extract_structured`(Upstage 정보추출)** 는 스키마 대비 의미 추출이라 문항↔보기
귀속이 구조적이다 — 시험지는 항상 이 도구를 쓴다(search_library 로 본문을 긁어 조립하지 말 것).

## 절차

1. **소스 찾기** — `search_library` 로 그 시험지를 검색(과목·연도·"시험" 등) → 결과의 `source_id`.
   (사용자가 파일명을 주면 그 내용 키워드로 검색해 해당 소스를 특정.)
2. **구조화** — `library_extract_structured({ sourceId, schema })` 를 아래 표준 스키마로 호출.
   여러 문항이 한 지문/대화를 공유하면 `passage` 에 담긴다.

   ```json
   { "type": "object", "properties": {
       "questions": { "type": "array", "items": { "type": "object", "properties": {
         "number":  { "type": "string", "description": "문항 번호" },
         "passage": { "type": "string", "description": "이 문항의 지문/대화문(있을 때만). 원문에서 답을 써넣도록 비워둔 자리(밑줄·빈칸)가 있으면 그 자리에 정확히 [[BLANK]] 표기를 넣어 문장을 완성할 것. 문장 순서는 원문 그대로." },
         "stem":    { "type": "string", "description": "문제 지시문. 지시문 안에 비워둔 자리가 있으면 거기에도 [[BLANK]] 표기" },
         "choices": { "type": "array", "items": { "type": "string" }, "description": "보기 4~5개, 번호표 제외한 텍스트만, 원 순서 유지" }
       } } }
   } }
   ```

   **빈칸 표기 필수** — `[[BLANK]]` 지시를 빼면 IE 가 빈칸을 서식 노이즈로 보고 지워버려
   "어디에 들어갈 말인지" 사라진다(실측). 렌더 시 `[[BLANK]]` → `______`(밑줄) 로 치환해 표시.

3. **렌더** — 반환 `questions` 를 `quiz_group` 으로. 매핑: `stem`→`question`, `choices`→`choices`,
   `number`→`number` + 각 문항에 `answerIndex`+`explanation` 을 **네 풀이로 채운다**(아래 정답 규칙).
   지문 공유 묶음은 그 지문을 quiz_group 의 `passage` 로 두고 문항을 함께 넣는다(지문마다 quiz_group
   하나). 문항 수가 많으면 대단원별로 여러 fence 로 나눠도 된다.

## 정답(answer)·해설 규칙

풀 수 있는 문제(영어 독해·어휘·문법·듣기 등 = 정답이 문항 안 논리로 결정되는 유형)는 **직접 풀어서**
각 문항의 `answerIndex`(0-based, 첫 보기=0)와 `explanation`(왜 그 답인지 근거)을 채운다. 이건 **모델의
풀이**이지 없는 사실을 지어내는 게 아니다 — 영어 문제 풀이는 역량 범위다(날조 = 없는 시세·코드·출처를
만드는 것이지, 주어진 문항을 추론으로 푸는 건 정당). 답변 서두에 한 줄만 명시: "공식 정답표가 없어
제가 푼 풀이입니다 — 공식 정답과 다를 수 있습니다."

- **정답표(답안지) PDF 를 사용자가 따로 올렸으면** 그것을 구조화해 문항 번호로 매칭 → `answerIndex`/
  `answer` 를 그 **공식 정답**으로 채운다(그때는 "공식 정답" 이라 명시 = authoritative 채점).
- 문항 안 근거만으로 정답이 결정되지 않는 유형(주관식 서술·외부 채점 기준 의존)만 `answer` 를 생략.
- `answerIndex` 를 채우면 인터랙티브 채점(보기 클릭 → 정답 확인 → 정답·해설 공개)이 동작한다.
  비우면 "정답 미제공" 으로 표시된다.

## 주의

- `library_extract_structured` 는 라이브러리 업로드 문서 전용(sourceId 필요). 라이브러리 밖 문서는
  대상이 아니다.
- 보기 텍스트는 원 순서 그대로(스키마가 순서를 보존). 번호(①②③④)는 컴포넌트가 자동으로 붙이니
  `choices` 텍스트에 원 번호를 넣지 말 것(중복 표기 방지).
- **빈칸 위치는 근사일 수 있다(엔진 한계)** — IE 는 의미 추출기라 문항↔보기 귀속·문장 순서는
  정확하지만 빈칸이 문장 안 어느 단어 사이인지는 한두 단어 어긋날 수 있다(실측: 문장 맨 앞
  빈칸이 두 번째 단어 뒤로). 빈칸 자리가 풀이에 결정적인 문항이면 "빈칸 위치는 원본과 다를 수
  있다"고 한 줄 덧붙이고, 정확한 원문이 필요하면 원본 PDF 를 함께 안내할 것. 임의로 옮겨
  "고쳐 놓지" 말 것(추측 배치 = 날조).
- 이미지로만 된 문항(채팅 캡처·화면 캡처 등)도 IE 는 **원본 PDF 를 직접 보므로** 추출된다 —
  라이브러리 파싱 텍스트(search_library)에 그 문항이 없다고 해서 빼지 말 것.
