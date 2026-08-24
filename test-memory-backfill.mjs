const response =
  await fetch(
    "http://localhost:3000/api/memory/backfill-test",
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json",
      },

      body:
        JSON.stringify({
          days:
            30,

          limit:
            25,
        }),
    }
  );

const text =
  await response.text();

if (!response.ok) {
  console.error(
    "Backfill request failed:"
  );

  console.error(
    text
  );

  process.exit(1);
}

let result;

try {
  result =
    JSON.parse(
      text
    );
} catch {
  console.error(
    "Backfill returned non-JSON:"
  );

  console.error(
    text
  );

  process.exit(1);
}

console.dir(
  result,
  {
    depth: null,
  }
);